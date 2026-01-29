import { z } from "zod";
import { findExecutionByBranch, updateExecution } from "../store/state.js";
export const setAgentIdInputSchema = z.object({
    branch: z.string().describe("Branch name"),
    agentTaskId: z.string().describe("Claude Task agent ID"),
});
export async function setAgentId(input) {
    // Find execution
    const exec = await findExecutionByBranch(input.branch);
    if (!exec) {
        throw new Error(`No execution found for branch: ${input.branch}`);
    }
    // Update agent task ID and status
    await updateExecution(exec.id, {
        agentTaskId: input.agentTaskId,
        status: "running",
        updatedAt: new Date(),
    });
    return {
        success: true,
        branch: input.branch,
        agentTaskId: input.agentTaskId,
    };
}
