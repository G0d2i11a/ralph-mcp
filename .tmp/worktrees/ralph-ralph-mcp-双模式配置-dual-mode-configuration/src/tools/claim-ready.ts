import { z } from "zod";
import {
  findExecutionByBranch,
  listUserStoriesByExecutionId,
  updateExecution,
  ExecutionRecord,
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
  const exec = await findExecutionByBranch(input.branch);

  if (!exec) {
    return {
      success: false,
      branch: input.branch,
      error: `No execution found for branch: ${input.branch}`,
    };
  }

  // Compare-and-swap: only claim if status is 'ready'
  if (exec.status !== "ready") {
    return {
      success: false,
      branch: input.branch,
      error: `Cannot claim: status is '${exec.status}', expected 'ready'`,
    };
  }

  // Atomically update to 'starting' and record launch attempt
  // Note: The state.ts uses a lock mechanism, so this is safe
  try {
    await updateExecution(exec.id, {
      status: "starting",
      launchAttemptAt: new Date(),
      launchAttempts: exec.launchAttempts + 1,
      updatedAt: new Date(),
    });
  } catch (e) {
    return {
      success: false,
      branch: input.branch,
      error: `Failed to update status: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Get user stories for prompt generation
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
    },
    undefined, // resumeContext
    exec.mode
  );

  return {
    success: true,
    branch: input.branch,
    agentPrompt,
    worktreePath: exec.worktreePath || exec.projectRoot,
  };
}
