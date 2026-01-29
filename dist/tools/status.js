import { z } from "zod";
import { listExecutions, listUserStoriesByExecutionId } from "../store/state.js";
export const statusInputSchema = z.object({
    project: z.string().optional().describe("Filter by project name"),
    status: z
        .enum(["pending", "running", "completed", "failed", "stopped", "merging"])
        .optional()
        .describe("Filter by status"),
});
export async function status(input) {
    const allExecutions = await listExecutions();
    // Filter in memory (simpler than building dynamic where clauses)
    let filtered = allExecutions;
    if (input.project) {
        filtered = filtered.filter((e) => e.project === input.project);
    }
    if (input.status) {
        filtered = filtered.filter((e) => e.status === input.status);
    }
    // Get story counts for each execution
    const executionStatuses = [];
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
        });
    }
    // Sort by last activity (most recent first)
    executionStatuses.sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
    // Calculate summary
    const summary = {
        total: executionStatuses.length,
        running: executionStatuses.filter((e) => e.status === "running").length,
        completed: executionStatuses.filter((e) => e.status === "completed").length,
        failed: executionStatuses.filter((e) => e.status === "failed").length,
        pending: executionStatuses.filter((e) => e.status === "pending").length,
    };
    return {
        executions: executionStatuses,
        summary,
    };
}
