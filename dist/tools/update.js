import { z } from "zod";
import notifier from "node-notifier";
import { findExecutionByBranch, findMergeQueueItemByExecutionId, findUserStoryById, insertMergeQueueItem, listMergeQueue, listUserStoriesByExecutionId, updateExecution, updateUserStory, } from "../store/state.js";
import { mergeQueueAction } from "./merge.js";
export const updateInputSchema = z.object({
    branch: z.string().describe("Branch name (e.g., ralph/task1-agent)"),
    storyId: z.string().describe("Story ID (e.g., US-001)"),
    passes: z.boolean().describe("Whether the story passes"),
    notes: z.string().optional().describe("Implementation notes"),
});
export async function update(input) {
    // Find execution by branch
    const exec = await findExecutionByBranch(input.branch);
    if (!exec) {
        throw new Error(`No execution found for branch: ${input.branch}`);
    }
    // Find and update the story
    const storyKey = `${exec.id}:${input.storyId}`;
    const story = await findUserStoryById(storyKey);
    if (!story) {
        throw new Error(`No story found with ID ${input.storyId} for branch ${input.branch}`);
    }
    // Update story
    await updateUserStory(storyKey, {
        passes: input.passes,
        notes: input.notes || story.notes,
    });
    // Update execution timestamp and status
    const allStories = await listUserStoriesByExecutionId(exec.id);
    // Check if this update completes all stories
    const updatedStories = allStories.map((s) => s.id === storyKey ? { ...s, passes: input.passes } : s);
    const allComplete = updatedStories.every((s) => s.passes);
    const completedCount = updatedStories.filter((s) => s.passes).length;
    // Update execution status
    const newStatus = allComplete ? "completed" : "running";
    await updateExecution(exec.id, { status: newStatus, updatedAt: new Date() });
    // Auto add to merge queue if enabled and all complete
    let addedToMergeQueue = false;
    if (allComplete && exec.autoMerge) {
        // Check if already in queue
        const existingInQueue = await findMergeQueueItemByExecutionId(exec.id);
        if (!existingInQueue) {
            const queue = await listMergeQueue();
            const maxPosition = queue.length > 0 ? Math.max(...queue.map((q) => q.position)) : 0;
            const nextPosition = maxPosition + 1;
            await insertMergeQueueItem({
                executionId: exec.id,
                position: nextPosition,
                status: "pending",
                createdAt: new Date(),
            });
            addedToMergeQueue = true;
            // Auto-process merge queue (fire and forget)
            setImmediate(async () => {
                try {
                    await mergeQueueAction({ action: "process" });
                }
                catch (e) {
                    console.error("Auto-merge failed:", e);
                }
            });
        }
    }
    // Send Windows toast notification when all complete (if enabled)
    if (allComplete && exec.notifyOnComplete) {
        notifier.notify({
            title: "Ralph PRD Complete",
            message: `${exec.branch} - All ${allStories.length} stories done!`,
            sound: true,
        });
    }
    return {
        success: true,
        branch: input.branch,
        storyId: input.storyId,
        passes: input.passes,
        allComplete,
        progress: `${completedCount}/${allStories.length} US`,
        addedToMergeQueue,
    };
}
