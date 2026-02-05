import { exec } from "child_process";
import { existsSync, readFileSync } from "fs";
import { freemem, totalmem } from "os";
import { promisify } from "util";
import { z } from "zod";
import matter from "gray-matter";
import { getConfig } from "../config/loader.js";
import {
  listExecutions,
  listArchivedExecutions,
  listUserStoriesByExecutionId,
  deleteExecution,
  deleteMergeQueueByExecutionId,
  updateExecution,
  archiveExecution,
  getRunnerConfig,
  ExecutionRecord,
  type ExecutionPriority,
  ReconcileReason,
} from "../store/state.js";
import { removeWorktree } from "../utils/worktree.js";
import {
  evaluateExecutionStaleness,
  type StaleDetectionConfig,
  type StaleDecision,
} from "../utils/stale-detection.js";

const execAsync = promisify(exec);

const DEBUG_RECONCILE =
  process.env.RALPH_DEBUG_RECONCILE === "1" ||
  process.env.RALPH_DEBUG_RECONCILE === "true";

function logReconcile(
  exec: ExecutionRecord,
  message: string,
  details?: Record<string, unknown>
): void {
  if (!DEBUG_RECONCILE) return;
  const prefix = `[ralph:reconcile] ${exec.branch} (${exec.id})`;
  if (!details) {
    console.log(prefix, message);
    return;
  }
  try {
    console.log(prefix, message, JSON.stringify(details));
  } catch {
    console.log(prefix, message, String(details));
  }
}

export const statusInputSchema = z.object({
  project: z.string().optional().describe("Filter by project name"),
  status: z
    .enum(["pending", "ready", "starting", "running", "interrupted", "completed", "failed", "stopped", "merging", "merged"])
    .optional()
    .describe("Filter by status"),
  reconcile: z
    .boolean()
    .optional()
    .default(true)
    .describe("Auto-fix status inconsistencies with git (default: true)"),
  historyLimit: z
    .number()
    .optional()
    .default(10)
    .describe("Number of recent archived records to include in history (default: 10)"),
});

export type StatusInput = z.infer<typeof statusInputSchema>;

export interface ExecutionStatus {
  branch: string;
  description: string;
  priority: ExecutionPriority;
  status: string;
  progress: string;
  completedStories: number;
  totalStories: number;
  acProgress: string; // e.g., "15/20 AC passing"
  worktreePath: string | null;
  agentTaskId: string | null;
  lastActivity: string;
  createdAt: string;
  // Stagnation metrics
  loopCount: number;
  consecutiveNoProgress: number;
  consecutiveErrors: number;
  lastError: string | null;
  // Interrupt detection
  isInterrupted: boolean;
  interruptReason: string | null;
  worktreeDirty: string | null; // Summary of uncommitted changes
}

export interface ReadyQueueItem {
  branch: string;
  description: string;
  priority: ExecutionPriority;
  createdAt: string;
}

export interface ReconcileAction {
  branch: string;
  previousStatus: string;
  action: "deleted" | "skipped" | "marked_interrupted" | "marked_completed" | "archived";
  reason: string;
}

/**
 * Summary of an archived execution for history display.
 */
export interface ArchivedExecutionSummary {
  branch: string;
  description: string;
  status: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
}

/**
 * Overall state of the Ralph system.
 */
export type OverallState = "never_run" | "active" | "all_done";

/**
 * Statistics about execution history.
 */
export interface ExecutionStats {
  totalExecuted: number;  // Total executions ever (active + archived)
  totalMerged: number;    // Successfully merged count
  totalFailed: number;    // Failed count (in archived)
}

export interface StatusResult {
  executions: ExecutionStatus[];
  readyQueue?: ReadyQueueItem[];
  summary: {
    total: number;
    running: number;
    completed: number;
    failed: number;
    pending: number;
    interrupted: number; // Executions that were interrupted (session closed)
    atRisk: number; // Executions approaching stagnation threshold
  };
  system?: {
    freeMemoryPercent: number;
    freeMemoryGB: number;
    effectiveConcurrency: number;
    maxConcurrency: number;
    pausedDueToMemory: boolean;
  };
  overallState: OverallState;
  history: ArchivedExecutionSummary[];
  stats: ExecutionStats;
  reconciled?: ReconcileAction[];
  suggestions?: string[]; // Suggested actions for the user
}

/**
 * Check if a branch is merged into main.
 */
async function isBranchMergedToMain(
  branch: string,
  projectRoot: string
): Promise<boolean> {
  try {
    // Try with origin/main first, fallback to main
    let mergeBase = "main";
    try {
      await execAsync("git rev-parse origin/main", { cwd: projectRoot });
      mergeBase = "origin/main";
    } catch {
      // No origin, use local main
    }

    const { stdout } = await execAsync(`git branch --merged ${mergeBase}`, {
      cwd: projectRoot,
    });

    const mergedBranches = stdout
      .split("\n")
      .map((b) => b.trim().replace(/^[*+]\s+/, ""));

    return mergedBranches.includes(branch);
  } catch {
    return false;
  }
}

async function getMainRef(projectRoot: string): Promise<string> {
  try {
    await execAsync("git rev-parse origin/main", { cwd: projectRoot });
    return "origin/main";
  } catch {
    return "main";
  }
}

async function isCommitAncestor(
  projectRoot: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  try {
    await execAsync(`git merge-base --is-ancestor "${ancestor}" "${descendant}"`, {
      cwd: projectRoot,
    });
    return true;
  } catch {
    return false;
  }
}

type PrdCompletionFrontmatter = {
  status: string | null;
  executedAt: string | null;
  mergeSha: string | null;
};

function readPrdCompletionFrontmatter(prdPath: string): PrdCompletionFrontmatter | null {
  if (!existsSync(prdPath)) return null;

  try {
    const raw = readFileSync(prdPath, "utf-8");

    const data: Record<string, unknown> = prdPath.toLowerCase().endsWith(".json")
      ? (JSON.parse(raw) as Record<string, unknown>)
      : ((matter(raw).data as Record<string, unknown>) ?? {});

    const status =
      typeof data.status === "string" ? data.status.trim().toLowerCase() : null;
    const executedAt = typeof data.executedAt === "string" ? data.executedAt.trim() : null;
    const mergeSha = typeof data.mergeSha === "string" ? data.mergeSha.trim() : null;

    return { status, executedAt, mergeSha };
  } catch {
    return null;
  }
}

function parseDateOrNull(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Get worktree dirty status (uncommitted changes summary).
 */
async function getWorktreeDirtyStatus(
  worktreePath: string
): Promise<string | null> {
  if (!existsSync(worktreePath)) {
    return null;
  }

  try {
    const { stdout } = await execAsync("git status --porcelain", {
      cwd: worktreePath,
    });

    if (!stdout.trim()) {
      return null; // Clean
    }

    const lines = stdout.trim().split("\n");
    const modified = lines.filter((l) => l.startsWith(" M") || l.startsWith("M ")).length;
    const added = lines.filter((l) => l.startsWith("A ")).length;
    const untracked = lines.filter((l) => l.startsWith("??")).length;
    const deleted = lines.filter((l) => l.startsWith(" D") || l.startsWith("D ")).length;

    const parts: string[] = [];
    if (modified > 0) parts.push(`${modified} modified`);
    if (added > 0) parts.push(`${added} added`);
    if (untracked > 0) parts.push(`${untracked} untracked`);
    if (deleted > 0) parts.push(`${deleted} deleted`);

    return parts.join(", ") || `${lines.length} changes`;
  } catch {
    return null;
  }
}

/**
 * Check if an execution is interrupted (running but no activity for too long).
 * Phase 2: Adaptive timeout + multi-signal detection (git commits + file mtimes + log mtime).
 */
const staleConfigCache = new Map<string, StaleDetectionConfig>();

function getStaleDetectionConfig(projectRoot: string): StaleDetectionConfig {
  const cached = staleConfigCache.get(projectRoot);
  if (cached) return cached;

  const config = getConfig(projectRoot);
  const stale = config.agent.staleDetection;

  const resolved: StaleDetectionConfig = {
    enabled: stale.enabled,
    timeoutsMs: stale.timeoutsMs,
    signals: stale.signals,
    maxFilesToStat: stale.maxFilesToStat,
    logTailBytes: stale.logTailBytes,
  };

  staleConfigCache.set(projectRoot, resolved);
  return resolved;
}

function formatAgeShort(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return remainMin > 0 ? `${hours}h${remainMin}m` : `${hours}h`;
}

function formatSignalAges(decision: StaleDecision, nowMs: number): string {
  const parts: string[] = [];
  const s = decision.signals;

  if (typeof s.stateUpdatedAtMs === "number") {
    parts.push(`state:${formatAgeShort(nowMs - s.stateUpdatedAtMs)}`);
  }
  if (typeof s.gitHeadCommitMs === "number") {
    parts.push(`git:${formatAgeShort(nowMs - s.gitHeadCommitMs)}`);
  }
  if (typeof s.changedFilesMaxMtimeMs === "number") {
    parts.push(`files:${formatAgeShort(nowMs - s.changedFilesMaxMtimeMs)}`);
  }
  if (typeof s.logMtimeMs === "number") {
    parts.push(`log:${formatAgeShort(nowMs - s.logMtimeMs)}`);
  }

  return parts.length > 0 ? parts.join(", ") : "no signals";
}

async function isExecutionInterrupted(exec: ExecutionRecord): Promise<{
  interrupted: boolean;
  reason: string | null;
  decision?: StaleDecision;
}> {
  if (exec.status !== "running") {
    return { interrupted: false, reason: null };
  }

  const nowMs = Date.now();
  const config = getStaleDetectionConfig(exec.projectRoot);

  const decision = await evaluateExecutionStaleness(
    {
      updatedAt: exec.updatedAt,
      currentStep: exec.currentStep,
      lastError: exec.lastError,
      projectRoot: exec.projectRoot,
      worktreePath: exec.worktreePath,
      logPath: exec.logPath,
    },
    config,
    nowMs
  );

  if (!decision.isStale) {
    return { interrupted: false, reason: null, decision };
  }

  const idle = formatAgeShort(decision.idleMs);
  const timeout = formatAgeShort(decision.timeoutMs);
  const signals = formatSignalAges(decision, nowMs);

  return {
    interrupted: true,
    reason: `No activity for ${idle} (timeout: ${timeout}, task: ${decision.taskType}, signals: ${signals})`,
    decision,
  };
}

/**
 * Check if a branch exists in the repository.
 */
async function doesBranchExist(
  branch: string,
  projectRoot: string
): Promise<boolean> {
  try {
    await execAsync(`git rev-parse --verify "${branch}"`, { cwd: projectRoot });
    return true;
  } catch {
    return false;
  }
}

async function getBranchHeadSha(
  branch: string,
  projectRoot: string
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`git rev-parse --verify "${branch}"`, {
      cwd: projectRoot,
    });
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Reconcile execution status with git reality.
 * - If a branch is merged to main, archive with reason "branch_merged".
 * - If a branch is deleted, mark as failed and archive with reason "branch_deleted".
 * - If worktree is missing, mark as failed and archive with reason "worktree_missing".
 * - If a running execution has no activity for too long, mark it as interrupted.
 */
async function reconcileExecutions(
  executions: ExecutionRecord[]
): Promise<ReconcileAction[]> {
  const actions: ReconcileAction[] = [];

  for (const exec of executions) {
    // Skip terminal state
    if (exec.status === "merged") {
      continue;
    }

    const isStopped = exec.status === "stopped";

    // If the PRD frontmatter has a mergeSha, it is the strongest signal that the PRD has been merged.
    // This also lets us recover from partial failures where the git branch was deleted after merge,
    // but state.json didn't get updated (e.g. process crash / manual merge).
    const prdMeta = readPrdCompletionFrontmatter(exec.prdPath);
    const prdMergeSha = prdMeta?.mergeSha ?? null;

    if (prdMergeSha && exec.baseCommitSha) {
      const mainRef = await getMainRef(exec.projectRoot);
      const isOnMain = await isCommitAncestor(exec.projectRoot, prdMergeSha, mainRef);
      const baseBeforeMerge = await isCommitAncestor(exec.projectRoot, exec.baseCommitSha, prdMergeSha);

      if (isOnMain && baseBeforeMerge) {
        try {
          logReconcile(exec, "archiving: prd frontmatter mergeSha indicates merged", {
            prdMergeSha,
            mainRef,
            baseCommitSha: exec.baseCommitSha,
          });

          if (exec.worktreePath) {
            try {
              await removeWorktree(exec.projectRoot, exec.worktreePath);
            } catch {
              // Worktree might already be gone
            }
          }

          const mergedAt = parseDateOrNull(prdMeta?.executedAt ?? null) ?? new Date();

          await updateExecution(
            exec.id,
            {
              status: "merged",
              mergedAt,
              mergeCommitSha: prdMergeSha,
              reconcileReason: "branch_merged" as ReconcileReason,
              updatedAt: new Date(),
            },
            { skipTransitionValidation: true }
          );

          await archiveExecution(exec.id);

          actions.push({
            branch: exec.branch,
            previousStatus: exec.status,
            action: "archived",
            reason: "PRD frontmatter has mergeSha (treating as merged)",
          });
          continue;
        } catch (error) {
          actions.push({
            branch: exec.branch,
            previousStatus: exec.status,
            action: "skipped",
            reason: `Failed to archive (prd mergeSha): ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      } else {
        logReconcile(exec, "skip: prd mergeSha present but not verifiable", {
          prdMergeSha,
          mainRef,
          baseCommitSha: exec.baseCommitSha,
          isOnMain,
          baseBeforeMerge,
        });
      }
    }

    // Check if branch is already merged
    const isMerged = await isBranchMergedToMain(exec.branch, exec.projectRoot);

    if (isMerged) {
      // IMPORTANT: A freshly-created branch from main (no divergence) is also "merged" per git.
      // Avoid "ghost merges" by only reconciling when the branch has advanced since execution start.
      const branchHeadSha = await getBranchHeadSha(exec.branch, exec.projectRoot);
      const baseCommitSha = exec.baseCommitSha;

      // If we can't resolve the current branch head, don't make destructive decisions.
      if (!branchHeadSha) {
        logReconcile(exec, "skip: unable to resolve branch head sha", {});
        continue;
      }

      if (!baseCommitSha) {
        // Should not happen for new executions (baseCommitSha is written at creation time).
        // For legacy/corrupted records, be conservative and avoid destructive reconcile.
        logReconcile(exec, "skip: missing baseCommitSha (cannot validate divergence)", { branchHeadSha });
        continue;
      }

      if (baseCommitSha === branchHeadSha) {
        // Leave status untouched: this execution hasn't produced any commits since it was created.
        logReconcile(exec, "skip: ghost-merge guard (no divergence yet)", {
          baseCommitSha,
          branchHeadSha,
        });
        continue;
      }

      // Branch is merged but status doesn't reflect it - archive it
      try {
        logReconcile(exec, "archiving: branch merged and diverged since start", {
          baseCommitSha,
          branchHeadSha,
        });
        // Try to remove worktree if exists
        if (exec.worktreePath) {
          try {
            await removeWorktree(exec.projectRoot, exec.worktreePath);
          } catch {
            // Worktree might already be gone
          }
        }

        // Update status to merged and set reconcile reason
        await updateExecution(exec.id, {
          status: "merged",
          reconcileReason: "branch_merged" as ReconcileReason,
          updatedAt: new Date(),
        }, { skipTransitionValidation: true });

        // Archive the execution
        await archiveExecution(exec.id);

        actions.push({
          branch: exec.branch,
          previousStatus: exec.status,
          action: "archived",
          reason: "Branch already merged to main",
        });
        continue;
      } catch (error) {
        actions.push({
          branch: exec.branch,
          previousStatus: exec.status,
          action: "skipped",
          reason: `Failed to archive: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    // Preserve semantics of "stopped": treat it as user-controlled pause.
    // We only reconcile it into an archive when we can prove it was merged above.
    if (isStopped) {
      continue;
    }

    // Check if branch was deleted
    const branchExists = await doesBranchExist(exec.branch, exec.projectRoot);
    if (!branchExists) {
      try {
        // Try to remove worktree if exists
        if (exec.worktreePath) {
          try {
            await removeWorktree(exec.projectRoot, exec.worktreePath);
          } catch {
            // Worktree might already be gone
          }
        }

        // Update status to failed and set reconcile reason
        await updateExecution(exec.id, {
          status: "failed",
          reconcileReason: "branch_deleted" as ReconcileReason,
          lastError: "Branch was deleted",
          updatedAt: new Date(),
        }, { skipTransitionValidation: true });

        // Archive the execution
        await archiveExecution(exec.id);

        actions.push({
          branch: exec.branch,
          previousStatus: exec.status,
          action: "archived",
          reason: "Branch was deleted",
        });
        continue;
      } catch (error) {
        actions.push({
          branch: exec.branch,
          previousStatus: exec.status,
          action: "skipped",
          reason: `Failed to archive deleted branch: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    // Check if worktree is missing (but branch exists)
    if (exec.worktreePath && !existsSync(exec.worktreePath) && exec.status === "running") {
      try {
        // Update status to failed and set reconcile reason
        await updateExecution(exec.id, {
          status: "failed",
          reconcileReason: "worktree_missing" as ReconcileReason,
          lastError: "Worktree directory is missing",
          worktreePath: null,
          updatedAt: new Date(),
        }, { skipTransitionValidation: true });

        // Archive the execution
        await archiveExecution(exec.id);

        actions.push({
          branch: exec.branch,
          previousStatus: exec.status,
          action: "archived",
          reason: "Worktree directory is missing",
        });
        continue;
      } catch (error) {
        actions.push({
          branch: exec.branch,
          previousStatus: exec.status,
          action: "skipped",
          reason: `Failed to archive missing worktree: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    // Check if running execution is interrupted (zombie)
    const { interrupted, reason } = await isExecutionInterrupted(exec);
    if (interrupted && reason) {
      try {
        // Check if all stories are complete before marking as failed
        const stories = await listUserStoriesByExecutionId(exec.id);
        const allComplete = stories.length > 0 && stories.every((s) => s.passes);

        if (allComplete) {
          // All stories done - mark as completed, not failed
          await updateExecution(exec.id, {
            status: "completed",
            lastError: null,
            updatedAt: new Date(),
          });

          actions.push({
            branch: exec.branch,
            previousStatus: exec.status,
            action: "marked_completed",
            reason: "All stories complete, session ended normally",
          });
        } else {
          // Mark as interrupted so Runner can auto-retry
          await updateExecution(exec.id, {
            status: "interrupted",
            lastError: reason,
            updatedAt: new Date(),
          });

          actions.push({
            branch: exec.branch,
            previousStatus: exec.status,
            action: "marked_interrupted",
            reason,
          });
        }
      } catch (error) {
        actions.push({
          branch: exec.branch,
          previousStatus: exec.status,
          action: "skipped",
          reason: `Failed to mark interrupted: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  return actions;
}

export async function status(input: StatusInput): Promise<StatusResult> {
  let allExecutions = await listExecutions();

  // Reconcile if enabled (default: true)
  let reconciled: ReconcileAction[] | undefined;
  if (input.reconcile !== false) {
    reconciled = await reconcileExecutions(allExecutions);

    // If any reconciliation happened, reload executions
    if (reconciled.length > 0) {
      allExecutions = await listExecutions();
    }
  }

  // Filter in memory (simpler than building dynamic where clauses)
  let filtered = allExecutions;
  if (input.project) {
    filtered = filtered.filter((e) => e.project === input.project);
  }
  if (input.status) {
    filtered = filtered.filter((e) => e.status === input.status);
  }

  // Get story counts for each execution
  const executionStatuses: ExecutionStatus[] = [];

  for (const exec of filtered) {
    const stories = await listUserStoriesByExecutionId(exec.id);

    const completedStories = stories.filter((s) => s.passes).length;
    const totalStories = stories.length;

    // Calculate AC progress across all stories
    let totalAc = 0;
    let passingAc = 0;
    for (const story of stories) {
      totalAc += story.acceptanceCriteria.length;
      const acEvidence = story.acEvidence || {};
      passingAc += Object.values(acEvidence).filter((ev) => ev.passes).length;
    }
    const acProgress = totalAc > 0 ? `${passingAc}/${totalAc} AC` : "No AC";

    // Check interrupt status
    const { interrupted, reason: interruptReason } = await isExecutionInterrupted(exec);

    // Get worktree dirty status
    const worktreeDirty = exec.worktreePath
      ? await getWorktreeDirtyStatus(exec.worktreePath)
      : null;

    executionStatuses.push({
      branch: exec.branch,
      description: exec.description,
      priority: exec.priority,
      status: exec.status,
      progress: `${completedStories}/${totalStories} US`,
      completedStories,
      totalStories,
      acProgress,
      worktreePath: exec.worktreePath,
      agentTaskId: exec.agentTaskId,
      lastActivity: exec.updatedAt.toISOString(),
      createdAt: exec.createdAt.toISOString(),
      // Stagnation metrics
      loopCount: exec.loopCount ?? 0,
      consecutiveNoProgress: exec.consecutiveNoProgress ?? 0,
      consecutiveErrors: exec.consecutiveErrors ?? 0,
      lastError: exec.lastError ?? null,
      // Interrupt detection
      isInterrupted: interrupted,
      interruptReason,
      worktreeDirty,
    });
  }

  // Sort by last activity (most recent first)
  executionStatuses.sort(
    (a, b) =>
      new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
  );

  // Calculate summary
  const interruptedExecutions = executionStatuses.filter((e) => e.isInterrupted);
  const summary = {
    total: executionStatuses.length,
    pending: executionStatuses.filter((e) => e.status === "pending").length,
    ready: executionStatuses.filter((e) => e.status === "ready").length,
    starting: executionStatuses.filter((e) => e.status === "starting").length,
    running: executionStatuses.filter((e) => e.status === "running" && !e.isInterrupted).length,
    completed: executionStatuses.filter((e) => e.status === "completed").length,
    failed: executionStatuses.filter((e) => e.status === "failed").length,
    interrupted: interruptedExecutions.length,
    atRisk: executionStatuses.filter(
      (e) => e.consecutiveNoProgress >= 2 || e.consecutiveErrors >= 3
    ).length,
  };

  // Get archived executions for history and stats
  const archivedExecutions = await listArchivedExecutions();

  // Calculate overall state
  let overallState: OverallState;
  if (allExecutions.length === 0 && archivedExecutions.length === 0) {
    overallState = "never_run";
  } else if (allExecutions.some((e) =>
    e.status === "running" || e.status === "pending" || e.status === "ready" ||
    e.status === "starting" || e.status === "merging"
  )) {
    overallState = "active";
  } else {
    overallState = "all_done";
  }

  // Build history from archived executions (most recent first)
  const historyLimit = input.historyLimit ?? 10;
  const sortedArchived = [...archivedExecutions].sort((a, b) => {
    const aTime = (a.mergedAt || a.updatedAt).getTime();
    const bTime = (b.mergedAt || b.updatedAt).getTime();
    return bTime - aTime; // Most recent first
  });

  const history: ArchivedExecutionSummary[] = sortedArchived
    .slice(0, historyLimit)
    .map((e) => ({
      branch: e.branch,
      description: e.description,
      status: e.status,
      mergedAt: e.mergedAt?.toISOString() || null,
      mergeCommitSha: e.mergeCommitSha,
      createdAt: e.createdAt.toISOString(),
    }));

  // Calculate stats
  const stats: ExecutionStats = {
    totalExecuted: allExecutions.length + archivedExecutions.length,
    totalMerged: archivedExecutions.filter((e) => e.status === "merged").length,
    totalFailed: archivedExecutions.filter((e) => e.status === "failed" || e.status === "stopped").length,
  };

  // Dynamic memory-based concurrency calculation
  const runnerConfig = await getRunnerConfig();
  const freeMemBytes = freemem();
  const totalMemBytes = totalmem();
  const freeMemoryPercent = (freeMemBytes / totalMemBytes) * 100;
  const freeMemGB = freeMemBytes / (1024 * 1024 * 1024);

  // Reserve 2GB for system + other apps, each agent needs ~800MB
  const RESERVED_GB = 2;
  const MEM_PER_AGENT_GB = 0.8;
  const availableForAgents = Math.max(0, freeMemGB - RESERVED_GB);
  const calculatedConcurrency = Math.floor(availableForAgents / MEM_PER_AGENT_GB);
  const effectiveConcurrency = Math.min(calculatedConcurrency, runnerConfig.maxConcurrency);
  const pausedDueToMemory = effectiveConcurrency === 0;

  const result: StatusResult = {
    executions: executionStatuses,
    summary,
    system: {
      freeMemoryPercent: Number(freeMemoryPercent.toFixed(1)),
      freeMemoryGB: Number(freeMemGB.toFixed(1)),
      effectiveConcurrency,
      maxConcurrency: runnerConfig.maxConcurrency,
      pausedDueToMemory,
    },
    overallState,
    history,
    stats,
  };

  // Optional: include a ready-queue view sorted by priority and age
  if (!input.status || input.status === "ready") {
    let readyQueueSource = allExecutions.filter((e) => e.status === "ready");
    if (input.project) {
      readyQueueSource = readyQueueSource.filter((e) => e.project === input.project);
    }

    const priorityWeight: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
    const readyQueue: ReadyQueueItem[] = readyQueueSource
      .slice()
      .sort((a, b) => {
        const aWeight = priorityWeight[a.priority] ?? priorityWeight.P1;
        const bWeight = priorityWeight[b.priority] ?? priorityWeight.P1;
        return (
          aWeight - bWeight ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.branch.localeCompare(b.branch)
        );
      })
      .map((e) => ({
        branch: e.branch,
        description: e.description,
        priority: e.priority,
        createdAt: e.createdAt.toISOString(),
      }));

    if (readyQueue.length > 0) {
      result.readyQueue = readyQueue;
    }
  }

  // Only include reconciled if there were actions
  if (reconciled && reconciled.length > 0) {
    result.reconciled = reconciled;
  }

  // Generate suggestions for interrupted or failed executions
  const suggestions: string[] = [];
  for (const exec of executionStatuses) {
    if (exec.status === "failed" || exec.isInterrupted) {
      const hasWip = exec.worktreeDirty ? " (has uncommitted changes)" : "";
      suggestions.push(
        `ralph_retry("${exec.branch}") - Resume${hasWip}`
      );
    }
  }
  if (suggestions.length > 0) {
    result.suggestions = suggestions;
  }

  return result;
}
