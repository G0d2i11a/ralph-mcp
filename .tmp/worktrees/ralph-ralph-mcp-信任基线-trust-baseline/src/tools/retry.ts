import { exec } from "child_process";
import { existsSync } from "fs";
import { promisify } from "util";
import { z } from "zod";
import {
  findExecutionByBranch,
  listUserStoriesByExecutionId,
  resetStagnation,
  updateExecution,
} from "../store/state.js";
import { generateAgentPrompt } from "../utils/agent.js";
import { createWorktree } from "../utils/worktree.js";

const execAsync = promisify(exec);

export const retryInputSchema = z.object({
  branch: z.string().describe("Branch name (e.g., ralph/task1-agent)"),
  wipPolicy: z
    .enum(["stash", "commit", "keep"])
    .optional()
    .default("stash")
    .describe(
      "How to handle uncommitted changes: stash (default), commit, or keep"
    ),
});

export type RetryInput = z.infer<typeof retryInputSchema>;

export interface RetryResult {
  success: boolean;
  branch: string;
  message: string;
  previousStatus: string;
  agentPrompt: string | null;
  progress: {
    completed: number;
    total: number;
    percentage: number;
  };
  wipHandled?: {
    policy: string;
    action: string;
    details: string | null;
  };
  worktreeRestored?: boolean;
}

/**
 * Get worktree dirty status details.
 */
async function getWorktreeStatus(
  worktreePath: string
): Promise<{ isDirty: boolean; summary: string; files: string[] }> {
  try {
    const { stdout } = await execAsync("git status --porcelain", {
      cwd: worktreePath,
    });

    if (!stdout.trim()) {
      return { isDirty: false, summary: "clean", files: [] };
    }

    const files = stdout.trim().split("\n");
    const modified = files.filter(
      (l) => l.startsWith(" M") || l.startsWith("M ")
    ).length;
    const untracked = files.filter((l) => l.startsWith("??")).length;

    const parts: string[] = [];
    if (modified > 0) parts.push(`${modified} modified`);
    if (untracked > 0) parts.push(`${untracked} untracked`);

    return {
      isDirty: true,
      summary: parts.join(", ") || `${files.length} changes`,
      files,
    };
  } catch {
    return { isDirty: false, summary: "unknown", files: [] };
  }
}

/**
 * Handle WIP (work in progress) based on policy.
 */
async function handleWip(
  worktreePath: string,
  policy: "stash" | "commit" | "keep"
): Promise<{ action: string; details: string | null }> {
  const status = await getWorktreeStatus(worktreePath);

  if (!status.isDirty) {
    return { action: "none", details: "Worktree is clean" };
  }

  switch (policy) {
    case "stash": {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const stashMessage = `ralph-wip-${timestamp}`;

        // Stash including untracked files
        await execAsync(`git stash push -u -m "${stashMessage}"`, {
          cwd: worktreePath,
        });

        return {
          action: "stashed",
          details: `Stashed ${status.summary} as "${stashMessage}". Use "git stash pop" to restore.`,
        };
      } catch (error) {
        return {
          action: "stash_failed",
          details: `Failed to stash: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    case "commit": {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const commitMessage = `ralph: WIP checkpoint ${timestamp}`;

        await execAsync("git add -A", { cwd: worktreePath });
        await execAsync(`git commit -m "${commitMessage}"`, {
          cwd: worktreePath,
        });

        return {
          action: "committed",
          details: `Committed ${status.summary} as WIP checkpoint. Can be squashed later.`,
        };
      } catch (error) {
        return {
          action: "commit_failed",
          details: `Failed to commit: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    case "keep":
    default:
      return {
        action: "kept",
        details: `Keeping ${status.summary} uncommitted. Agent will continue with dirty worktree.`,
      };
  }
}

/**
 * Retry a failed/interrupted PRD execution.
 * Supports resuming from breakpoint with WIP handling.
 */
export async function retry(input: RetryInput): Promise<RetryResult> {
  const exec = await findExecutionByBranch(input.branch);

  if (!exec) {
    throw new Error(`No execution found for branch: ${input.branch}`);
  }

  const previousStatus = exec.status;

  // Allow retry for failed, stopped, or running (interrupted) executions
  if (
    previousStatus !== "failed" &&
    previousStatus !== "stopped" &&
    previousStatus !== "running"
  ) {
    return {
      success: false,
      branch: input.branch,
      message: `Cannot retry execution with status '${previousStatus}'. Only 'failed', 'stopped', or 'running' (interrupted) executions can be retried.`,
      previousStatus,
      agentPrompt: null,
      progress: { completed: 0, total: 0, percentage: 0 },
    };
  }

  // Check/restore worktree
  let worktreeRestored = false;
  let worktreePath = exec.worktreePath;

  if (!worktreePath || !existsSync(worktreePath)) {
    // Worktree doesn't exist, try to recreate it
    try {
      worktreePath = await createWorktree(exec.projectRoot, exec.branch);
      worktreeRestored = true;

      // Update execution with new worktree path
      await updateExecution(exec.id, {
        worktreePath,
        updatedAt: new Date(),
      });
    } catch (error) {
      return {
        success: false,
        branch: input.branch,
        message: `Failed to restore worktree: ${error instanceof Error ? error.message : String(error)}`,
        previousStatus,
        agentPrompt: null,
        progress: { completed: 0, total: 0, percentage: 0 },
      };
    }
  }

  // Handle WIP (uncommitted changes)
  const wipResult = await handleWip(worktreePath!, input.wipPolicy || "stash");

  // Reset stagnation counters
  await resetStagnation(exec.id);

  // Set status back to running
  await updateExecution(exec.id, {
    status: "running",
    lastError: null,
    updatedAt: new Date(),
  });

  // Get stories and generate new agent prompt
  const stories = await listUserStoriesByExecutionId(exec.id);
  const completed = stories.filter((s) => s.passes).length;
  const total = stories.length;

  // Build context about the resume
  const resumeContext = [
    `RESUMING FROM BREAKPOINT:`,
    `- Previous status: ${previousStatus}`,
    `- Completed: ${completed}/${total} User Stories`,
    worktreeRestored ? `- Worktree was restored` : null,
    wipResult.action !== "none"
      ? `- WIP handled: ${wipResult.action} - ${wipResult.details}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const agentPrompt = generateAgentPrompt(
    exec.branch,
    exec.description,
    worktreePath!,
    stories.map((s) => ({
      storyId: s.storyId,
      title: s.title,
      description: s.description,
      acceptanceCriteria: s.acceptanceCriteria,
      priority: s.priority,
      passes: s.passes,
    })),
    undefined, // contextPath
    {
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastError: null,
    },
    resumeContext
  );

  return {
    success: true,
    branch: input.branch,
    message: `Execution resumed. ${total - completed} stories remaining.`,
    previousStatus,
    agentPrompt,
    progress: {
      completed,
      total,
      percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
    },
    wipHandled: {
      policy: input.wipPolicy || "stash",
      action: wipResult.action,
      details: wipResult.details,
    },
    worktreeRestored,
  };
}
