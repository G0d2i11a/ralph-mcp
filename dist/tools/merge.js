import { z } from "zod";
import { removeWorktree, abortMerge, } from "../utils/worktree.js";
import { generateMergeAgentPrompt, startMergeAgent, } from "../utils/agent.js";
import { syncMainToBranch, runQualityChecks, generateCommitMessage, updateTodoDoc, updateProjectStatus, handleSchemaConflict, } from "../utils/merge-helpers.js";
import { execSync } from "child_process";
import { deleteMergeQueueByExecutionId, findExecutionByBranch, findExecutionById, insertMergeQueueItem, listExecutions, listMergeQueue, listUserStoriesByExecutionId, updateExecution, updateMergeQueueItem, } from "../store/state.js";
export const mergeInputSchema = z.object({
    branch: z.string().describe("Branch name to merge (e.g., ralph/task1-agent)"),
    force: z.boolean().default(false).describe("Skip verification checks"),
    skipQualityChecks: z.boolean().default(false).describe("Skip type check and build"),
    onConflict: z
        .enum(["auto_theirs", "auto_ours", "notify", "agent"])
        .optional()
        .describe("Override conflict resolution strategy"),
});
export async function merge(input) {
    // Find execution
    const exec = await findExecutionByBranch(input.branch);
    if (!exec) {
        throw new Error(`No execution found for branch: ${input.branch}`);
    }
    // Get completed stories for commit message
    const stories = await listUserStoriesByExecutionId(exec.id);
    const completedStories = stories
        .filter((s) => s.passes)
        .map((s) => ({ id: s.storyId, title: s.title }));
    // Check if all stories are complete (unless force)
    if (!input.force) {
        const { get } = await import("./get.js");
        const status = await get({ branch: input.branch });
        if (status.progress.completed < status.progress.total) {
            throw new Error(`Cannot merge: ${status.progress.completed}/${status.progress.total} stories complete. Use force=true to override.`);
        }
    }
    // Update status to merging
    await updateExecution(exec.id, { status: "merging", updatedAt: new Date() });
    const onConflict = input.onConflict || exec.onConflict || "agent";
    try {
        // Step 1: Sync main to feature branch (in worktree)
        if (exec.worktreePath) {
            console.log(">>> Syncing main to feature branch...");
            const syncResult = await syncMainToBranch(exec.worktreePath, exec.branch);
            if (!syncResult.success) {
                if (syncResult.hasConflicts && syncResult.conflictFiles) {
                    // Try to handle schema conflicts automatically
                    const hasSchemaConflict = syncResult.conflictFiles.some((f) => f.includes("schema.prisma"));
                    if (hasSchemaConflict) {
                        console.log(">>> Attempting to resolve schema.prisma conflict...");
                        const schemaResolved = await handleSchemaConflict(exec.worktreePath);
                        if (!schemaResolved) {
                            throw new Error(`Failed to resolve schema.prisma conflict during sync`);
                        }
                        // Continue with remaining conflicts if any
                        const remainingConflicts = syncResult.conflictFiles.filter((f) => !f.includes("schema.prisma"));
                        if (remainingConflicts.length > 0) {
                            throw new Error(`Sync conflicts in: ${remainingConflicts.join(", ")}`);
                        }
                    }
                    else {
                        throw new Error(syncResult.message);
                    }
                }
                else {
                    throw new Error(syncResult.message);
                }
            }
        }
        // Step 2: Run quality checks (unless skipped)
        if (!input.skipQualityChecks && exec.worktreePath) {
            console.log(">>> Running quality checks...");
            const qualityResult = await runQualityChecks(exec.worktreePath);
            if (!qualityResult.success) {
                const failedChecks = [];
                if (!qualityResult.typeCheck.success)
                    failedChecks.push("typeCheck");
                if (!qualityResult.build.success)
                    failedChecks.push("build");
                await updateExecution(exec.id, { status: "failed", updatedAt: new Date() });
                return {
                    success: false,
                    branch: input.branch,
                    cleanedUp: false,
                    qualityChecks: {
                        typeCheck: qualityResult.typeCheck.success,
                        build: qualityResult.build.success,
                    },
                    message: `Quality checks failed: ${failedChecks.join(", ")}. Fix issues before merging.`,
                };
            }
        }
        // Step 3: Generate commit message
        const commitMessage = generateCommitMessage(exec.branch, exec.description, completedStories);
        // Step 4: Attempt merge to main
        console.log(">>> Merging to main...");
        const mergeResult = await mergeBranchWithMessage(exec.projectRoot, exec.branch, commitMessage, onConflict);
        if (mergeResult.success) {
            // Step 5: Update docs
            const docsUpdated = [];
            if (updateTodoDoc(exec.projectRoot, exec.branch, exec.description)) {
                docsUpdated.push("docs/TODO.md");
            }
            if (mergeResult.commitHash &&
                updateProjectStatus(exec.projectRoot, exec.branch, exec.description, mergeResult.commitHash)) {
                docsUpdated.push("docs/PROJECT-STATUS.md");
            }
            // Commit doc updates if any
            if (docsUpdated.length > 0) {
                try {
                    execSync(`git add ${docsUpdated.join(" ")} && git commit --amend --no-edit`, {
                        cwd: exec.projectRoot,
                    });
                }
                catch {
                    // Ignore if no changes or amend fails
                }
            }
            // Step 6: Clean up worktree
            let cleanedUp = false;
            if (exec.worktreePath) {
                try {
                    await removeWorktree(exec.projectRoot, exec.worktreePath);
                    cleanedUp = true;
                }
                catch (e) {
                    console.error("Failed to remove worktree:", e);
                }
            }
            // Update status
            await updateExecution(exec.id, { status: "completed", updatedAt: new Date() });
            return {
                success: true,
                branch: input.branch,
                commitHash: mergeResult.commitHash,
                cleanedUp,
                conflictResolution: "auto",
                qualityChecks: input.skipQualityChecks
                    ? undefined
                    : { typeCheck: true, build: true },
                docsUpdated: docsUpdated.length > 0 ? docsUpdated : undefined,
                mergedStories: completedStories.map((s) => s.id),
                message: `Successfully merged ${input.branch} to main`,
            };
        }
        // Handle conflicts
        if (mergeResult.hasConflicts && mergeResult.conflictFiles) {
            // Try schema conflict resolution first
            const hasSchemaConflict = mergeResult.conflictFiles.some((f) => f.includes("schema.prisma"));
            if (hasSchemaConflict) {
                console.log(">>> Attempting to resolve schema.prisma conflict...");
                const schemaResolved = await handleSchemaConflict(exec.projectRoot);
                if (schemaResolved) {
                    // Check if there are remaining conflicts
                    const remainingConflicts = mergeResult.conflictFiles.filter((f) => !f.includes("schema.prisma"));
                    if (remainingConflicts.length === 0) {
                        // Complete the merge
                        try {
                            execSync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, {
                                cwd: exec.projectRoot,
                            });
                            const commitHash = execSync("git rev-parse HEAD", {
                                cwd: exec.projectRoot,
                                encoding: "utf-8",
                            }).trim();
                            // Clean up
                            let cleanedUp = false;
                            if (exec.worktreePath) {
                                try {
                                    await removeWorktree(exec.projectRoot, exec.worktreePath);
                                    cleanedUp = true;
                                }
                                catch (e) {
                                    console.error("Failed to remove worktree:", e);
                                }
                            }
                            await updateExecution(exec.id, { status: "completed", updatedAt: new Date() });
                            return {
                                success: true,
                                branch: input.branch,
                                commitHash,
                                cleanedUp,
                                conflictResolution: "auto",
                                mergedStories: completedStories.map((s) => s.id),
                                message: `Successfully merged ${input.branch} (schema conflict auto-resolved)`,
                            };
                        }
                        catch {
                            // Fall through to agent resolution
                        }
                    }
                }
            }
            if (onConflict === "notify") {
                await updateExecution(exec.id, { status: "failed", updatedAt: new Date() });
                return {
                    success: false,
                    branch: input.branch,
                    cleanedUp: false,
                    conflictResolution: "pending",
                    message: `Merge conflicts detected in: ${mergeResult.conflictFiles.join(", ")}. Manual resolution required.`,
                };
            }
            if (onConflict === "agent") {
                const prompt = generateMergeAgentPrompt(exec.projectRoot, exec.branch, exec.description, mergeResult.conflictFiles, exec.prdPath);
                const agentResult = await startMergeAgent(exec.projectRoot, prompt);
                if (agentResult.success) {
                    let cleanedUp = false;
                    if (exec.worktreePath) {
                        try {
                            await removeWorktree(exec.projectRoot, exec.worktreePath);
                            cleanedUp = true;
                        }
                        catch (e) {
                            console.error("Failed to remove worktree:", e);
                        }
                    }
                    const commitHash = execSync("git rev-parse HEAD", {
                        cwd: exec.projectRoot,
                        encoding: "utf-8",
                    }).trim();
                    await updateExecution(exec.id, { status: "completed", updatedAt: new Date() });
                    return {
                        success: true,
                        branch: input.branch,
                        commitHash,
                        cleanedUp,
                        conflictResolution: "agent",
                        mergedStories: completedStories.map((s) => s.id),
                        message: `Merge conflicts resolved by agent for ${input.branch}`,
                    };
                }
                else {
                    await abortMerge(exec.projectRoot);
                    await updateExecution(exec.id, { status: "failed", updatedAt: new Date() });
                    return {
                        success: false,
                        branch: input.branch,
                        cleanedUp: false,
                        conflictResolution: "pending",
                        message: `Merge agent failed: ${agentResult.output}`,
                    };
                }
            }
        }
        throw new Error("Unexpected merge state");
    }
    catch (error) {
        await updateExecution(exec.id, { status: "failed", updatedAt: new Date() });
        throw error;
    }
}
/**
 * Merge branch with custom commit message
 */
async function mergeBranchWithMessage(projectRoot, branch, commitMessage, onConflict) {
    const { exec: execAsync } = await import("child_process");
    const { promisify } = await import("util");
    const execPromise = promisify(execAsync);
    // Check if origin remote exists
    let hasOrigin = false;
    try {
        const { stdout } = await execPromise("git remote", { cwd: projectRoot });
        hasOrigin = stdout.includes("origin");
    }
    catch {
        hasOrigin = false;
    }
    // Checkout main and pull (only if origin exists)
    if (hasOrigin) {
        await execPromise("git checkout main && git pull", { cwd: projectRoot });
    }
    else {
        await execPromise("git checkout main", { cwd: projectRoot });
    }
    // Build merge strategy
    let mergeStrategy = "";
    if (onConflict === "auto_theirs") {
        mergeStrategy = "-X theirs";
    }
    else if (onConflict === "auto_ours") {
        mergeStrategy = "-X ours";
    }
    try {
        // Use heredoc-style commit message to handle special characters
        const escapedMessage = commitMessage.replace(/'/g, "'\\''");
        await execPromise(`git merge --no-ff ${mergeStrategy} "${branch}" -m '${escapedMessage}'`, { cwd: projectRoot });
        const { stdout: hash } = await execPromise("git rev-parse HEAD", {
            cwd: projectRoot,
        });
        return {
            success: true,
            commitHash: hash.trim(),
            hasConflicts: false,
        };
    }
    catch {
        // Check for conflicts
        const { stdout: status } = await execPromise("git status --porcelain", {
            cwd: projectRoot,
        });
        const conflictFiles = status
            .split("\n")
            .filter((line) => line.startsWith("UU ") || line.startsWith("AA "))
            .map((line) => line.slice(3));
        if (conflictFiles.length > 0) {
            return {
                success: false,
                hasConflicts: true,
                conflictFiles,
            };
        }
        throw new Error("Merge failed for unknown reason");
    }
}
// Merge queue management
export const mergeQueueInputSchema = z.object({
    action: z
        .enum(["list", "add", "remove", "process"])
        .default("list")
        .describe("Queue action"),
    branch: z.string().optional().describe("Branch for add/remove actions"),
});
export async function mergeQueueAction(input) {
    const queue = await listMergeQueue();
    const current = queue.find((q) => q.status === "merging");
    if (input.action === "list") {
        const execs = await listExecutions();
        const execById = new Map(execs.map((e) => [e.id, e]));
        return {
            queue: queue.map((q) => {
                const exec = execById.get(q.executionId);
                return exec?.branch || q.executionId;
            }),
            current: current
                ? execById.get(current.executionId)?.branch
                : undefined,
            message: `${queue.length} items in merge queue`,
        };
    }
    if (input.action === "add" && input.branch) {
        const exec = await findExecutionByBranch(input.branch);
        if (!exec) {
            throw new Error(`No execution found for branch: ${input.branch}`);
        }
        const maxPosition = queue.length > 0
            ? Math.max(...queue.map((q) => q.position))
            : 0;
        await insertMergeQueueItem({
            executionId: exec.id,
            position: maxPosition + 1,
            status: "pending",
            createdAt: new Date(),
        });
        return {
            queue: [...queue.map((q) => q.executionId), exec.id],
            message: `Added ${input.branch} to merge queue at position ${maxPosition + 1}`,
        };
    }
    if (input.action === "remove" && input.branch) {
        const exec = await findExecutionByBranch(input.branch);
        if (exec) {
            await deleteMergeQueueByExecutionId(exec.id);
        }
        return {
            queue: queue
                .filter((q) => q.executionId !== exec?.id)
                .map((q) => q.executionId),
            message: `Removed ${input.branch} from merge queue`,
        };
    }
    if (input.action === "process") {
        // Process next item in queue
        const next = queue.find((q) => q.status === "pending");
        if (!next) {
            return {
                queue: [],
                message: "No pending items in merge queue",
            };
        }
        const exec = await findExecutionById(next.executionId);
        if (exec) {
            // Update queue status
            await updateMergeQueueItem(next.id, { status: "merging" });
            // Perform merge
            const result = await merge({ branch: exec.branch, force: false, skipQualityChecks: false });
            // Update queue status
            await updateMergeQueueItem(next.id, { status: result.success ? "completed" : "failed" });
            return {
                queue: queue.slice(1).map((q) => q.executionId),
                current: exec.branch,
                message: result.message,
            };
        }
    }
    return {
        queue: queue.map((q) => q.executionId),
        message: "Unknown action",
    };
}
