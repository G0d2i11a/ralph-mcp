import { z } from "zod";
import { removeWorktree } from "../utils/worktree.js";
import {
  deleteExecution,
  findExecutionByBranch,
  updateExecution,
} from "../store/state.js";

export const stopInputSchema = z.object({
  branch: z.string().describe("Branch name to stop (e.g., ralph/task1-agent)"),
  cleanup: z.boolean().default(false).describe("Also remove the worktree"),
  deleteRecord: z.boolean().default(false).describe("Delete the execution record from database"),
});

export type StopInput = z.infer<typeof stopInputSchema>;

export interface StopResult {
  success: boolean;
  branch: string;
  previousStatus: string;
  cleanedUp: boolean;
  deleted: boolean;
  message: string;
}

export async function stop(input: StopInput): Promise<StopResult> {
  // Find execution
  const exec = await findExecutionByBranch(input.branch);

  if (!exec) {
    throw new Error(`No execution found for branch: ${input.branch}`);
  }

  const previousStatus = exec.status;

  // Optionally clean up worktree
  let cleanedUp = false;
  if (input.cleanup && exec.worktreePath) {
    try {
      await removeWorktree(exec.projectRoot, exec.worktreePath);
      cleanedUp = true;
    } catch (e) {
      console.error("Failed to remove worktree:", e);
    }
  }

  // Delete or update
  let deleted = false;
  if (input.deleteRecord) {
    await deleteExecution(exec.id);
    deleted = true;
  } else {
    // Just update status
    await updateExecution(exec.id, { status: "stopped", updatedAt: new Date() });
  }

  const actions = [];
  if (deleted) actions.push("deleted record");
  if (cleanedUp) actions.push("removed worktree");
  if (!deleted) actions.push("stopped");

  return {
    success: true,
    branch: input.branch,
    previousStatus,
    cleanedUp,
    deleted,
    message: `${input.branch}: ${actions.join(", ")}`,
  };
}
