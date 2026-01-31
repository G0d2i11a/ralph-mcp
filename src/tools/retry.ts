import { z } from "zod";
import {
  findExecutionByBranch,
  listUserStoriesByExecutionId,
  resetStagnation,
  updateExecution,
} from "../store/state.js";
import { generateAgentPrompt } from "../utils/agent.js";

export const retryInputSchema = z.object({
  branch: z.string().describe("Branch name (e.g., ralph/task1-agent)"),
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
}

/**
 * Retry a failed PRD execution.
 * Resets stagnation counters and generates a new agent prompt.
 */
export async function retry(input: RetryInput): Promise<RetryResult> {
  const exec = await findExecutionByBranch(input.branch);

  if (!exec) {
    throw new Error(`No execution found for branch: ${input.branch}`);
  }

  const previousStatus = exec.status;

  // Only allow retry for failed or stopped executions
  if (previousStatus !== "failed" && previousStatus !== "stopped") {
    return {
      success: false,
      branch: input.branch,
      message: `Cannot retry execution with status '${previousStatus}'. Only 'failed' or 'stopped' executions can be retried.`,
      previousStatus,
      agentPrompt: null,
      progress: { completed: 0, total: 0, percentage: 0 },
    };
  }

  // Reset stagnation counters
  await resetStagnation(exec.id);

  // Set status back to running
  await updateExecution(exec.id, {
    status: "running",
    updatedAt: new Date(),
  });

  // Get stories and generate new agent prompt
  const stories = await listUserStoriesByExecutionId(exec.id);
  const completed = stories.filter((s) => s.passes).length;
  const total = stories.length;

  const agentPrompt = generateAgentPrompt(
    exec.branch,
    exec.description,
    exec.worktreePath || exec.projectRoot,
    stories.map((s) => ({
      storyId: s.storyId,
      title: s.title,
      description: s.description,
      acceptanceCriteria: s.acceptanceCriteria,
      priority: s.priority,
      passes: s.passes,
    })),
    undefined, // contextPath - would need to re-read from PRD
    {
      loopCount: 0, // Reset loop context for fresh start
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastError: null,
    }
  );

  return {
    success: true,
    branch: input.branch,
    message: `Execution retried. ${total - completed} stories remaining.`,
    previousStatus,
    agentPrompt,
    progress: {
      completed,
      total,
      percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
    },
  };
}
