import { z } from "zod";
import {
  findExecutionByBranch,
  resetStagnation,
  updateExecution,
} from "../store/state.js";

export const resetStagnationInputSchema = z.object({
  branch: z.string().describe("Branch name (e.g., ralph/task1-agent)"),
  resumeExecution: z
    .boolean()
    .default(true)
    .describe("Also set status back to 'running' if currently 'failed'"),
});

export type ResetStagnationInput = z.infer<typeof resetStagnationInputSchema>;

export interface ResetStagnationResult {
  success: boolean;
  branch: string;
  message: string;
  previousStatus: string;
  newStatus: string;
}

/**
 * Reset stagnation counters for an execution.
 * Use this after manual intervention to allow the agent to continue.
 */
export async function resetStagnationTool(
  input: ResetStagnationInput
): Promise<ResetStagnationResult> {
  const exec = await findExecutionByBranch(input.branch);

  if (!exec) {
    throw new Error(`No execution found for branch: ${input.branch}`);
  }

  const previousStatus = exec.status;

  // Reset stagnation counters
  await resetStagnation(exec.id);

  // Optionally resume execution
  let newStatus = previousStatus;
  if (input.resumeExecution && previousStatus === "failed") {
    await updateExecution(exec.id, {
      status: "running",
      updatedAt: new Date(),
    });
    newStatus = "running";
  }

  return {
    success: true,
    branch: input.branch,
    message:
      previousStatus === "failed" && input.resumeExecution
        ? "Stagnation counters reset and execution resumed"
        : "Stagnation counters reset",
    previousStatus,
    newStatus,
  };
}
