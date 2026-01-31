import { exec } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import {
  listExecutions,
  listUserStoriesByExecutionId,
  deleteExecution,
  deleteMergeQueueByExecutionId,
  ExecutionRecord,
} from "../store/state.js";
import { removeWorktree } from "../utils/worktree.js";

const execAsync = promisify(exec);

export const statusInputSchema = z.object({
  project: z.string().optional().describe("Filter by project name"),
  status: z
    .enum(["pending", "running", "completed", "failed", "stopped", "merging"])
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
  worktreePath: string | null;
  agentTaskId: string | null;
  lastActivity: string;
  createdAt: string;
  // Stagnation metrics
  loopCount: number;
  consecutiveNoProgress: number;
  consecutiveErrors: number;
  lastError: string | null;
}

export interface ReconcileAction {
  branch: string;
  previousStatus: string;
  action: "deleted" | "skipped";
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
    atRisk: number; // Executions approaching stagnation threshold
  };
  reconciled?: ReconcileAction[];
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
 * Reconcile execution status with git reality.
 * If a branch is merged to main but status is not "completed", clean it up.
 */
async function reconcileExecutions(
  executions: ExecutionRecord[]
): Promise<ReconcileAction[]> {
  const actions: ReconcileAction[] = [];

  for (const exec of executions) {
    // Only reconcile non-completed, non-stopped executions
    if (exec.status === "completed" || exec.status === "stopped") {
      continue;
    }

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
      } catch (error) {
        actions.push({
          branch: exec.branch,
          previousStatus: exec.status,
          action: "skipped",
          reason: `Failed to clean up: ${error instanceof Error ? error.message : String(error)}`,
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

    executionStatuses.push({
      branch: exec.branch,
      description: exec.description,
      status: exec.status,
      progress: `${completedStories}/${totalStories} US`,
      completedStories,
      totalStories,
      worktreePath: exec.worktreePath,
      agentTaskId: exec.agentTaskId,
      lastActivity: exec.updatedAt.toISOString(),
      createdAt: exec.createdAt.toISOString(),
      // Stagnation metrics
      loopCount: exec.loopCount ?? 0,
      consecutiveNoProgress: exec.consecutiveNoProgress ?? 0,
      consecutiveErrors: exec.consecutiveErrors ?? 0,
      lastError: exec.lastError ?? null,
    });
  }

  // Sort by last activity (most recent first)
  executionStatuses.sort(
    (a, b) =>
      new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
  );

  // Calculate summary
  const summary = {
    total: executionStatuses.length,
    running: executionStatuses.filter((e) => e.status === "running").length,
    completed: executionStatuses.filter((e) => e.status === "completed").length,
    failed: executionStatuses.filter((e) => e.status === "failed").length,
    pending: executionStatuses.filter((e) => e.status === "pending").length,
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

  return result;
}
