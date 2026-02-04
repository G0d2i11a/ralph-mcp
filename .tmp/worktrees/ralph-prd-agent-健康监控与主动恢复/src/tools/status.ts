import { exec } from "child_process";
import { existsSync } from "fs";
import { promisify } from "util";
import { z } from "zod";
import {
  listExecutions,
  listArchivedExecutions,
  listUserStoriesByExecutionId,
  deleteExecution,
  deleteMergeQueueByExecutionId,
  updateExecution,
  archiveExecution,
  ExecutionRecord,
  ReconcileReason,
} from "../store/state.js";
import { removeWorktree } from "../utils/worktree.js";

const execAsync = promisify(exec);

// Timeout threshold for detecting interrupted executions (30 minutes)
const INTERRUPT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Format time elapsed in human-readable format (e.g., "2m ago", "1h ago").
 */
function formatTimeSince(timestamp: Date): string {
  const now = Date.now();
  const elapsed = now - timestamp.getTime();

  if (elapsed < 60000) {
    // Less than 1 minute
    return `${Math.floor(elapsed / 1000)}s ago`;
  } else if (elapsed < 3600000) {
    // Less than 1 hour
    return `${Math.floor(elapsed / 60000)}m ago`;
  } else if (elapsed < 86400000) {
    // Less than 1 day
    return `${Math.floor(elapsed / 3600000)}h ago`;
  } else {
    // Days
    return `${Math.floor(elapsed / 86400000)}d ago`;
  }
}

export const statusInputSchema = z.object({
  project: z.string().optional().describe("Filter by project name"),
  status: z
    .enum(["pending", "ready", "starting", "running", "completed", "failed", "stopped", "merging", "merged"])
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
  status: string;
  progress: string;
  completedStories: number;
  totalStories: number;
  acProgress: string; // e.g., "15/20 AC passing"
  worktreePath: string | null;
  agentTaskId: string | null;
  agentPid: number | null; // Process ID of the agent (US-002)
  processStatus: "alive" | "dead" | "unknown"; // Process liveness status (US-002)
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
  // Health monitoring (US-001)
  healthStatus: "active" | "idle" | "at_risk" | "stale" | null;
  lastActivityAt: string | null; // ISO timestamp of last detected activity
  timeSinceActivity: string | null; // Human-readable time since activity (e.g., "2m ago")
  // Auto recovery (US-005)
  recoveryCount: number; // Number of auto-recovery attempts
  recoveryHistory: Array<{
    timestamp: string;
    reason: string;
    attemptNumber: number;
    success: boolean;
    error?: string;
  }>;
}

export interface ReconcileAction {
  branch: string;
  previousStatus: string;
  action: "deleted" | "skipped" | "marked_interrupted" | "archived";
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

/**
 * API health status (US-006).
 */
export interface ApiHealthInfo {
  healthy: boolean;
  checkedAt: string;
  error: string | null;
}

export interface StatusResult {
  executions: ExecutionStatus[];
  summary: {
    total: number;
    running: number;
    completed: number;
    failed: number;
    pending: number;
    interrupted: number; // Executions that were interrupted (session closed)
    atRisk: number; // Executions approaching stagnation threshold or at_risk health status
    stale: number; // Executions with stale health status (US-001)
  };
  overallState: OverallState;
  history: ArchivedExecutionSummary[];
  stats: ExecutionStats;
  apiHealth: ApiHealthInfo; // API health status (US-006)
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
      .map((b) => b.trim().replace(/^\* /, ""));

    return mergedBranches.includes(branch);
  } catch {
    return false;
  }
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
 */
function isExecutionInterrupted(exec: ExecutionRecord): {
  interrupted: boolean;
  reason: string | null;
} {
  if (exec.status !== "running") {
    return { interrupted: false, reason: null };
  }

  const lastActivity = exec.updatedAt.getTime();
  const now = Date.now();
  const elapsed = now - lastActivity;

  if (elapsed > INTERRUPT_TIMEOUT_MS) {
    const minutes = Math.round(elapsed / 60000);
    return {
      interrupted: true,
      reason: `No activity for ${minutes} minutes (likely session closed)`,
    };
  }

  return { interrupted: false, reason: null };
}

/**
 * Check if a process with the given PID is alive (US-002).
 * Works on both Windows and Unix platforms.
 */
async function checkProcessStatus(pid: number | null): Promise<"alive" | "dead" | "unknown"> {
  if (pid === null) {
    return "unknown";
  }

  return new Promise((resolve) => {
    if (process.platform === "win32") {
      // Windows: use tasklist to check if PID exists
      exec(`tasklist /FI "PID eq ${pid}" /NH`, (error, stdout) => {
        if (error) {
          resolve("unknown");
          return;
        }
        // tasklist returns "INFO: No tasks are running..." if PID not found
        const output = stdout.toLowerCase();
        if (output.includes("no tasks")) {
          resolve("dead");
        } else if (output.includes(String(pid))) {
          resolve("alive");
        } else {
          resolve("unknown");
        }
      });
    } else {
      // Unix: use kill -0 to check if process exists (doesn't actually kill)
      exec(`kill -0 ${pid} 2>/dev/null`, (error) => {
        resolve(error ? "dead" : "alive");
      });
    }
  });
}

/**
 * Check if a branch exists in the repository.
 */
async function doesBranchExist(
  branch: string,
  projectRoot: string
): Promise<boolean> {
  try {
    await execAsync(`git rev-parse --verify ${branch}`, { cwd: projectRoot });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check API health by running `claude --version` (US-006).
 */
async function checkApiHealth(): Promise<ApiHealthInfo> {
  const checkedAt = new Date().toISOString();

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({
        healthy: false,
        checkedAt,
        error: "Health check timed out (5s)",
      });
    }, 5000);

    exec("claude --version", { timeout: 5000 }, (error, stdout, stderr) => {
      clearTimeout(timeout);

      if (error) {
        resolve({
          healthy: false,
          checkedAt,
          error: `CLI error: ${error.message}${stderr ? ` (${stderr.trim()})` : ""}`,
        });
        return;
      }

      // Check if we got a valid version response
      if (stdout && stdout.trim().length > 0) {
        resolve({ healthy: true, checkedAt, error: null });
      } else {
        resolve({
          healthy: false,
          checkedAt,
          error: "Empty response from claude --version",
        });
      }
    });
  });
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
    // Skip already merged or stopped executions
    if (exec.status === "merged" || exec.status === "stopped") {
      continue;
    }

    // Check if branch is already merged
    const isMerged = await isBranchMergedToMain(exec.branch, exec.projectRoot);

    if (isMerged) {
      // Branch is merged but status doesn't reflect it - archive it
      try {
        // Try to remove worktree if exists
        if (exec.worktreePath) {
          try {
            await removeWorktree(exec.worktreePath, exec.projectRoot);
          } catch {
            // Worktree might already be gone
          }
        }

        // Update status to merged and set reconcile reason
        await updateExecution(exec.id, {
          status: "merged",
          reconcileReason: "branch_merged" as ReconcileReason,
          mergedAt: new Date(),
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

    // Check if branch was deleted
    const branchExists = await doesBranchExist(exec.branch, exec.projectRoot);
    if (!branchExists) {
      try {
        // Try to remove worktree if exists
        if (exec.worktreePath) {
          try {
            await removeWorktree(exec.worktreePath, exec.projectRoot);
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
    const { interrupted, reason } = isExecutionInterrupted(exec);
    if (interrupted && reason) {
      try {
        // Mark as failed so it can be retried
        await updateExecution(exec.id, {
          status: "failed",
          lastError: reason,
          updatedAt: new Date(),
        });

        actions.push({
          branch: exec.branch,
          previousStatus: exec.status,
          action: "marked_interrupted",
          reason,
        });
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
    const { interrupted, reason: interruptReason } = isExecutionInterrupted(exec);

    // Get worktree dirty status
    const worktreeDirty = exec.worktreePath
      ? await getWorktreeDirtyStatus(exec.worktreePath)
      : null;

    // Check process liveness (US-002)
    const processStatus = exec.status === "running"
      ? await checkProcessStatus(exec.agentPid)
      : "unknown";

    executionStatuses.push({
      branch: exec.branch,
      description: exec.description,
      status: exec.status,
      progress: `${completedStories}/${totalStories} US`,
      completedStories,
      totalStories,
      acProgress,
      worktreePath: exec.worktreePath,
      agentTaskId: exec.agentTaskId,
      agentPid: exec.agentPid,
      processStatus,
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
      // Health monitoring (US-001)
      healthStatus: exec.healthStatus,
      lastActivityAt: exec.lastActivityAt ? exec.lastActivityAt.toISOString() : null,
      timeSinceActivity: exec.lastActivityAt ? formatTimeSince(exec.lastActivityAt) : null,
      // Auto recovery (US-005)
      recoveryCount: exec.recoveryCount ?? 0,
      recoveryHistory: (exec.recoveryLog ?? []).map((entry) => ({
        timestamp: entry.timestamp.toISOString(),
        reason: entry.reason,
        attemptNumber: entry.attemptNumber,
        success: entry.success,
        error: entry.error,
      })),
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
      (e) => e.healthStatus === "at_risk" || e.consecutiveNoProgress >= 2 || e.consecutiveErrors >= 3
    ).length,
    stale: executionStatuses.filter((e) => e.healthStatus === "stale").length,
    // Auto recovery stats (US-005)
    totalRecoveries: executionStatuses.reduce((sum, e) => sum + e.recoveryCount, 0),
    executionsWithRecovery: executionStatuses.filter((e) => e.recoveryCount > 0).length,
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

  // Check API health (US-006)
  const apiHealth = await checkApiHealth();

  const result: StatusResult = {
    executions: executionStatuses,
    summary,
    overallState,
    history,
    stats,
    apiHealth,
  };

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
