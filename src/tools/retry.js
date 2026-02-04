"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.retryInputSchema = void 0;
exports.retry = retry;
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const util_1 = require("util");
const zod_1 = require("zod");
const state_js_1 = require("../store/state.js");
const agent_js_1 = require("../utils/agent.js");
const worktree_js_1 = require("../utils/worktree.js");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
exports.retryInputSchema = zod_1.z.object({
    branch: zod_1.z.string().describe("Branch name (e.g., ralph/task1-agent)"),
    wipPolicy: zod_1.z
        .enum(["stash", "commit", "keep"])
        .optional()
        .default("stash")
        .describe("How to handle uncommitted changes: stash (default), commit, or keep"),
});
/**
 * Get worktree dirty status details.
 */
async function getWorktreeStatus(worktreePath) {
    try {
        const { stdout } = await execAsync("git status --porcelain", {
            cwd: worktreePath,
        });
        if (!stdout.trim()) {
            return { isDirty: false, summary: "clean", files: [] };
        }
        const files = stdout.trim().split("\n");
        const modified = files.filter((l) => l.startsWith(" M") || l.startsWith("M ")).length;
        const untracked = files.filter((l) => l.startsWith("??")).length;
        const parts = [];
        if (modified > 0)
            parts.push(`${modified} modified`);
        if (untracked > 0)
            parts.push(`${untracked} untracked`);
        return {
            isDirty: true,
            summary: parts.join(", ") || `${files.length} changes`,
            files,
        };
    }
    catch {
        return { isDirty: false, summary: "unknown", files: [] };
    }
}
/**
 * Handle WIP (work in progress) based on policy.
 */
async function handleWip(worktreePath, policy) {
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
            }
            catch (error) {
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
            }
            catch (error) {
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
async function retry(input) {
    const exec = await (0, state_js_1.findExecutionByBranch)(input.branch);
    if (!exec) {
        throw new Error(`No execution found for branch: ${input.branch}`);
    }
    const previousStatus = exec.status;
    // Allow retry for failed, stopped, or running (interrupted) executions
    if (previousStatus !== "failed" &&
        previousStatus !== "stopped" &&
        previousStatus !== "running") {
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
    if (!worktreePath || !(0, fs_1.existsSync)(worktreePath)) {
        // Worktree doesn't exist, try to recreate it
        try {
            worktreePath = await (0, worktree_js_1.createWorktree)(exec.projectRoot, exec.branch);
            worktreeRestored = true;
            // Update execution with new worktree path
            await (0, state_js_1.updateExecution)(exec.id, {
                worktreePath,
                updatedAt: new Date(),
            });
        }
        catch (error) {
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
    const wipResult = await handleWip(worktreePath, input.wipPolicy || "stash");
    // Reset stagnation counters
    await (0, state_js_1.resetStagnation)(exec.id);
    // Get stories and generate new agent prompt
    const stories = await (0, state_js_1.listUserStoriesByExecutionId)(exec.id);
    const completed = stories.filter((s) => s.passes).length;
    const total = stories.length;
    // Check if all stories are already complete
    const allComplete = total > 0 && completed === total;
    if (allComplete) {
        // All stories done - set to completed, not running
        await (0, state_js_1.updateExecution)(exec.id, {
            status: "completed",
            lastError: null,
            updatedAt: new Date(),
        });
        return {
            success: true,
            branch: input.branch,
            message: `Execution resumed. 0 stories remaining.`,
            previousStatus,
            agentPrompt: "All user stories are complete. No action needed.",
            progress: {
                completed,
                total,
                percentage: 100,
            },
            wipHandled: {
                policy: input.wipPolicy || "stash",
                action: wipResult.action,
                details: wipResult.details,
            },
            worktreeRestored,
        };
    }
    // Set status to ready so Runner can pick it up (not running - that's set after agent launches)
    // IMPORTANT: Reset launchAttempts to allow Runner to retry
    await (0, state_js_1.updateExecution)(exec.id, {
        status: "ready",
        lastError: null,
        launchAttempts: 0,
        updatedAt: new Date(),
    });
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
    const agentPrompt = (0, agent_js_1.generateAgentPrompt)(exec.branch, exec.description, worktreePath, stories.map((s) => ({
        storyId: s.storyId,
        title: s.title,
        description: s.description,
        acceptanceCriteria: s.acceptanceCriteria,
        priority: s.priority,
        passes: s.passes,
    })), undefined, // contextPath
    {
        loopCount: 0,
        consecutiveNoProgress: 0,
        consecutiveErrors: 0,
        lastError: null,
    }, resumeContext);
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
