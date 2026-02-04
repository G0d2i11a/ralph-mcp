import { exec } from "child_process";
import { existsSync } from "fs";
import { promisify } from "util";
import { z } from "zod";
import {
  listExecutions,
  listUserStoriesByExecutionId,
  deleteExecution,
  deleteMergeQueueByExecutionId,
  updateExecution,
  ExecutionRecord,
} from "../store/state.js";
import { removeWorktree } from "../utils/worktree.js";

const execAsync = promisify(exec);

// Timeout threshold for detecting interrupted executions (30 minutes)
const INTERRUPT_TIMEOUT_MS = 30 * 60 * 1000;

export const statusInputSchema = z.object({
  project: z.string().optional().describe("Filter by project name"),
  status: z
    .enum(["pending", "ready", "starting", "running", "completed", "failed", "stopped", "merging"])
    .optional()
    .describe("Filter by status"),
  reconcile: z
    .boolean()
    .optional()
    .default(true)
    .describe("Auto-fix status inconsistencies with git (default: true)"),
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

export interface ReconcileAction {
  branch: string;
  previousStatus: string;
  action: "deleted" | "skipped" | "marked_interrupted";
  reason: string;
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
 * Reconcile execution status with git reality.
 * - If a branch is merged to main but status is not "completed", clean it up.
 * - If a running execution has no activity for too long, mark it as interrupted.
 */
async function reconcileExecutions(
  executions: ExecutionRecord[]
): Promise<ReconcileAction[]> {
  const actions: ReconcileAction[] = [];

  for (const exec of executions) {
    // Skip completed or stopped executions
    if (exec.status === "completed" || exec.status === "stopped") {
      continue;
    }

    // Check if branch is already merged
    const isMerged = await isBranchMergedToMain(exec.branch, exec.projectRoot);

    if (isMerged) {
      // Branch is merged but status doesn't reflect it - clean up
      try {
        // Remove from merge queue
        await deleteMergeQueueByExecutionId(exec.id);

        // Try to remove worktree if exists
        if (exec.worktreePath) {
          try {
            await removeWorktree(exec.worktreePath, exec.projectRoot);
          } catch {
            // Worktree might already be gone
          }
        }

        // Delete the execution record
        await deleteExecution(exec.id);

        actions.push({
          branch: exec.branch,
          previousStatus: exec.status,
          action: "deleted",
          reason: "Branch already merged to main",
        });
        continue;
      } catch (error) {
        actions.push({
          branch: exec.branch,
          previousStatus: exec.status,
          action: "skipped",
          reason: `Failed to clean up: ${error instanceof Error ? error.message : String(error)}`,
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

  const result: StatusResult = {
    executions: executionStatuses,
    summary,
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
