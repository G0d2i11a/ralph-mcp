import { z } from "zod";
import {
  claimReadyExecution,
  listUserStoriesByExecutionId,
} from "../store/state.js";
import { generateAgentPrompt } from "../utils/agent.js";

export const claimReadyInputSchema = z.object({
  branch: z.string().describe("Branch name of the PRD to claim (e.g., ralph/task1-agent)"),
});

export type ClaimReadyInput = z.infer<typeof claimReadyInputSchema>;

export interface ClaimReadyResult {
  success: boolean;
  branch: string;
  agentPrompt?: string;
  worktreePath?: string;
  error?: string;
}

/**
 * Atomically claim a ready PRD for execution.
 *
 * This implements a compare-and-swap pattern:
 * 1. Check if status is `ready`
 * 2. Atomically update to `starting`
 * 3. Generate agent prompt for the Runner to use
 *
 * If the status is not `ready`, returns success: false.
 * This prevents race conditions when multiple Runners try to claim the same PRD.
 */
export async function claimReady(input: ClaimReadyInput): Promise<ClaimReadyResult> {
  const claim = await claimReadyExecution(input.branch);
  if (!claim.success || !claim.execution) {
    return {
      success: false,
      branch: input.branch,
      error: claim.error || "Failed to claim execution",
    };
  }

  // Get user stories for prompt generation
  const exec = claim.execution;
  const stories = await listUserStoriesByExecutionId(exec.id);

  // Generate agent prompt
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
    undefined, // contextInjectionPath - could be added later
    {
      loopCount: exec.loopCount,
      consecutiveNoProgress: exec.consecutiveNoProgress,
      consecutiveErrors: exec.consecutiveErrors,
      lastError: exec.lastError,
    }
  );

  return {
    success: true,
    branch: input.branch,
    agentPrompt,
    worktreePath: exec.worktreePath || exec.projectRoot,
  };
}
