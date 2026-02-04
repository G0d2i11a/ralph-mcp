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
  STAGNATION_THRESHOLDS,
} from "../store/state.js";
import { removeWorktree } from "../utils/worktree.js";

const execAsync = promisify(exec);

// Timeout threshold for detecting interrupted executions (30 minutes)
const INTERRUPT_TIMEOUT_MS = 30 * 60 * 1000;

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
  // US-005: Verbose mode for detailed AC-level progress
  verbose: z
    .boolean()
    .optional()
    .default(false)
    .describe("Show detailed AC-level progress for each story (default: false)"),
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
  lastActivity: string;
  createdAt: string;
  // US-005: Timeline metrics
  timeline: {
    startedAt: string;
    runningDuration: string; // Human-readable duration (e.g., "2h 30m")
    lastUpdateAt: string;
  };
  // US-005: Speed metrics
  speed: {
    avgTimePerStory: string | null; // Average time per completed story (e.g., "15m")
    currentStoryElapsed: string | null; // Time spent on current story (e.g., "5m")
  };
  // US-005: Estimated time remaining (for reference only)
  estimatedRemaining: string | null; // e.g., "45m" or null if cannot estimate
  // US-005: Health metrics
  health: {
    stagnationCount: number; // Total stagnation events
    retryCount: number; // Total retry attempts (loopCount)
    blockedStoryCount: number; // Number of blocked stories
    healthScore: "healthy" | "warning" | "critical"; // Overall health assessment
  };
  // US-005: Progress bar representation
  progressBar: string; // e.g., "████████░░░░░░░░ 50%"
  // US-005: Detailed story progress (only in verbose mode)
  storyDetails?: Array<{
    storyId: string;
    title: string;
    status: "pending" | "in_progress" | "completed" | "blocked";
    acProgress: string; // e.g., "3/5 AC"
    acDetails?: Array<{
      acId: string;
      description: string;
      passes: boolean;
      evidence?: string;
    }>;
  }>;
  // Stagnation metrics
  loopCount: number;
  consecutiveNoProgress: number;
  consecutiveErrors: number;
  lastError: string | null;
  // US-004: Enhanced stagnation metrics
  consecutiveSimilarNotes: number;
  // US-004: Stagnation warnings (active warnings based on current state)
  stagnationWarnings: Array<{
    type: "idle_retry" | "no_progress" | "repeated_error";
    message: string;
    severity: "warning" | "critical";
  }>;
  // US-004: Stagnation log (historical record of warnings and blocks)
  stagnationLog: Array<{
    timestamp: string;
    type: "warning" | "blocked";
    reason: "idle_retry" | "no_progress" | "repeated_error";
    message: string;
  }>;
  // Interrupt detection
  isInterrupted: boolean;
  interruptReason: string | null;
  worktreeDirty: string | null; // Summary of uncommitted changes
  // Blocked stories
  blockedStories: Array<{
    storyId: string;
    title: string;
    blockedReason: {
      type: string;
      description: string;
      suggestedAction: string;
    };
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

export interface StatusResult {
  executions: ExecutionStatus[];
  summary: {
    total: number;
    running: number;
    completed: number;
    failed: number;
    pending: number;
    interrupted: number; // Executions that were interrupted (session closed)
    atRisk: number; // Executions approaching stagnation threshold
  };
  overallState: OverallState;
  history: ArchivedExecutionSummary[];
  stats: ExecutionStats;
  reconciled?: ReconcileAction[];
  suggestions?: string[]; // Suggested actions for the user
}

// =============================================================================
// US-005: Progress Visualization Helper Functions
// =============================================================================

/**
 * Format duration in milliseconds to human-readable string.
 * e.g., 3661000 -> "1h 1m", 120000 -> "2m", 45000 -> "45s"
 */
function formatDuration(ms: number): string {
  if (ms < 0) return "0s";

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

/**
 * Generate a progress bar string.
 * @param progress - Progress value between 0 and 1
 * @param width - Total width of the progress bar (default: 16)
 * @returns Progress bar string like "████████░░░░░░░░ 50%"
 */
function generateProgressBar(progress: number, width = 16): string {
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const filled = Math.round(clampedProgress * width);
  const empty = width - filled;
  const percentage = Math.round(clampedProgress * 100);

  const filledChar = "█";
  const emptyChar = "░";

  return `${filledChar.repeat(filled)}${emptyChar.repeat(empty)} ${percentage}%`;
}

/**
 * Determine health score based on stagnation metrics.
 */
function calculateHealthScore(
  stagnationCount: number,
  blockedCount: number,
  consecutiveNoProgress: number,
  consecutiveErrors: number
): "healthy" | "warning" | "critical" {
  // Critical if any blocking condition
  if (blockedCount > 0 || consecutiveNoProgress >= 3 || consecutiveErrors >= 3) {
    return "critical";
  }

  // Warning if approaching thresholds
  if (
    stagnationCount > 2 ||
    consecutiveNoProgress >= 2 ||
    consecutiveErrors >= 2
  ) {
    return "warning";
  }

  return "healthy";
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

    // Collect blocked stories
    const blockedStories = stories
      .filter((s) => s.blocked && s.blockedReason)
      .map((s) => ({
        storyId: s.storyId,
        title: s.title,
        blockedReason: s.blockedReason!,
      }));

    // US-004: Build stagnation warnings based on current state
    const stagnationWarnings: ExecutionStatus["stagnationWarnings"] = [];

    // Check for idle retry warning
    if ((exec.consecutiveSimilarNotes ?? 0) >= 2) {
      stagnationWarnings.push({
        type: "idle_retry",
        message: `Similar notes detected ${exec.consecutiveSimilarNotes} consecutive times - possible idle retry loop`,
        severity: (exec.consecutiveSimilarNotes ?? 0) >= 3 ? "critical" : "warning",
      });
    }

    // Check for no progress warning
    if ((exec.consecutiveNoProgress ?? 0) >= 2) {
      stagnationWarnings.push({
        type: "no_progress",
        message: `No file changes for ${exec.consecutiveNoProgress} consecutive updates`,
        severity: (exec.consecutiveNoProgress ?? 0) >= 3 ? "critical" : "warning",
      });
    }

    // Check for repeated error warning
    if ((exec.consecutiveErrors ?? 0) >= 2) {
      stagnationWarnings.push({
        type: "repeated_error",
        message: `Same error repeated ${exec.consecutiveErrors} times`,
        severity: (exec.consecutiveErrors ?? 0) >= 3 ? "critical" : "warning",
      });
    }

    // US-004: Format stagnation log for output
    const stagnationLog = (exec.stagnationLog ?? []).map((entry) => ({
      timestamp: entry.timestamp.toISOString(),
      type: entry.type,
      reason: entry.reason,
      message: entry.message,
    }));

    // =========================================================================
    // US-005: Progress Visualization Enhancement
    // =========================================================================

    const now = new Date();
    const createdAt = exec.createdAt;
    const updatedAt = exec.updatedAt;

    // Timeline metrics
    const runningDurationMs = now.getTime() - createdAt.getTime();
    const timeline = {
      startedAt: createdAt.toISOString(),
      runningDuration: formatDuration(runningDurationMs),
      lastUpdateAt: updatedAt.toISOString(),
    };

    // Speed metrics
    let avgTimePerStory: string | null = null;
    let currentStoryElapsed: string | null = null;

    if (completedStories > 0) {
      // Calculate average time per completed story
      const avgMs = runningDurationMs / completedStories;
      avgTimePerStory = formatDuration(avgMs);
    }

    // Find current (in-progress) story - the first non-completed, non-blocked story
    const currentStory = stories.find((s) => !s.passes && !s.blocked);
    if (currentStory && exec.status === "running") {
      // Estimate time on current story as time since last update
      const timeSinceLastUpdate = now.getTime() - updatedAt.getTime();
      currentStoryElapsed = formatDuration(timeSinceLastUpdate);
    }

    const speed = {
      avgTimePerStory,
      currentStoryElapsed,
    };

    // Estimated remaining time (based on average speed)
    let estimatedRemaining: string | null = null;
    const remainingStories = totalStories - completedStories;
    if (avgTimePerStory && remainingStories > 0 && completedStories > 0) {
      const avgMs = runningDurationMs / completedStories;
      const estimatedMs = avgMs * remainingStories;
      estimatedRemaining = formatDuration(estimatedMs);
    }

    // Health metrics
    const stagnationCount = stagnationLog.length;
    const healthScore = calculateHealthScore(
      stagnationCount,
      blockedStories.length,
      exec.consecutiveNoProgress ?? 0,
      exec.consecutiveErrors ?? 0
    );

    const health = {
      stagnationCount,
      retryCount: exec.loopCount ?? 0,
      blockedStoryCount: blockedStories.length,
      healthScore,
    };

    // Progress bar
    const progressRatio = totalStories > 0 ? completedStories / totalStories : 0;
    const progressBar = generateProgressBar(progressRatio);

    // Story details (only in verbose mode)
    let storyDetails: ExecutionStatus["storyDetails"] | undefined;
    if (input.verbose) {
      storyDetails = stories.map((story) => {
        // Determine story status
        let storyStatus: "pending" | "in_progress" | "completed" | "blocked";
        if (story.passes) {
          storyStatus = "completed";
        } else if (story.blocked) {
          storyStatus = "blocked";
        } else if (story === currentStory) {
          storyStatus = "in_progress";
        } else {
          storyStatus = "pending";
        }

        // Calculate AC progress for this story
        const storyAcEvidence = story.acEvidence || {};
        const storyPassingAc = Object.values(storyAcEvidence).filter((ev) => ev.passes).length;
        const storyTotalAc = story.acceptanceCriteria.length;
        const storyAcProgress = `${storyPassingAc}/${storyTotalAc} AC`;

        // AC details
        const acDetails = story.acceptanceCriteria.map((ac, index) => {
          const acId = `AC-${index + 1}`;
          const evidence = storyAcEvidence[acId];
          return {
            acId,
            description: ac,
            passes: evidence?.passes ?? false,
            evidence: evidence?.evidence,
          };
        });

        return {
          storyId: story.storyId,
          title: story.title,
          status: storyStatus,
          acProgress: storyAcProgress,
          acDetails,
        };
      });
    }

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
      lastActivity: exec.updatedAt.toISOString(),
      createdAt: exec.createdAt.toISOString(),
      // US-005: Timeline, speed, and health metrics
      timeline,
      speed,
      estimatedRemaining,
      health,
      progressBar,
      storyDetails,
      // Stagnation metrics
      loopCount: exec.loopCount ?? 0,
      consecutiveNoProgress: exec.consecutiveNoProgress ?? 0,
      consecutiveErrors: exec.consecutiveErrors ?? 0,
      lastError: exec.lastError ?? null,
      // US-004: Enhanced stagnation metrics
      consecutiveSimilarNotes: exec.consecutiveSimilarNotes ?? 0,
      stagnationWarnings,
      stagnationLog,
      // Interrupt detection
      isInterrupted: interrupted,
      interruptReason,
      worktreeDirty,
      // Blocked stories
      blockedStories,
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
      (e) => e.consecutiveNoProgress >= 2 || e.consecutiveErrors >= 2 || e.consecutiveSimilarNotes >= 2
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

  const result: StatusResult = {
    executions: executionStatuses,
    summary,
    overallState,
    history,
    stats,
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
