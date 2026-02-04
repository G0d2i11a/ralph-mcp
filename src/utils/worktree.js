"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWorktree = createWorktree;
exports.removeWorktree = removeWorktree;
exports.listWorktrees = listWorktrees;
exports.mergeBranch = mergeBranch;
exports.abortMerge = abortMerge;
exports.getConflictFiles = getConflictFiles;
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const path_1 = require("path");
const util_1 = require("util");
const schema_js_1 = require("../config/schema.js");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
/**
 * Create a new git worktree for a branch
 */
async function createWorktree(projectRoot, branch, config) {
    const worktreeConfig = config?.worktree || schema_js_1.DEFAULT_CONFIG.worktree;
    const mergeConfig = config?.merge || schema_js_1.DEFAULT_CONFIG.merge;
    const branchPrefix = mergeConfig.branchPrefix;
    const mainBranch = mergeConfig.mainBranch;
    const worktreeBaseDir = worktreeConfig.baseDir;
    const worktreePrefix = worktreeConfig.prefix;
    // Extract short name from branch (ralph/task1-agent -> task1-agent)
    const shortName = branch.replace(new RegExp(`^${branchPrefix}`), "");
    const worktreePath = (0, path_1.join)(projectRoot, worktreeBaseDir, `${worktreePrefix}${shortName}`);
    // Check if worktree already exists
    if ((0, fs_1.existsSync)(worktreePath)) {
        console.log(`Worktree already exists at ${worktreePath}`);
        return worktreePath;
    }
    // Check if branch exists
    const branchExists = await checkBranchExists(projectRoot, branch);
    if (branchExists) {
        // Worktree for existing branch
        await execAsync(`git worktree add "${worktreePath}" "${branch}"`, { cwd: projectRoot });
    }
    else {
        // Create new branch from main
        await execAsync(`git worktree add -b "${branch}" "${worktreePath}" ${mainBranch}`, { cwd: projectRoot });
    }
    // Prevent ralph-progress.md from being committed
    try {
        const { stdout: gitCommonDir } = await execAsync("git rev-parse --git-common-dir", {
            cwd: worktreePath,
        });
        const excludePath = (0, path_1.join)(gitCommonDir.trim(), "info", "exclude");
        // Ensure info directory exists
        // (git-common-dir usually returns absolute path or relative to cwd.
        // If relative, join with worktreePath might be needed, but rev-parse usually returns absolute if outside?
        // Actually rev-parse --git-common-dir usually returns absolute path if called with proper context or relative.
        // Safest is to resolve it.)
        // Let's rely on reading current content to check if needed
        let content = "";
        if ((0, fs_1.existsSync)(excludePath)) {
            content = (0, fs_1.readFileSync)(excludePath, "utf-8");
        }
        if (!content.includes("ralph-progress.md")) {
            (0, fs_1.appendFileSync)(excludePath, "\nralph-progress.md\n", "utf-8");
        }
    }
    catch (e) {
        console.error("Failed to update .git/info/exclude:", e);
        // Non-fatal error
    }
    return worktreePath;
}
/**
 * Remove a git worktree and optionally delete the branch
 */
async function removeWorktree(projectRoot, worktreePath, deleteBranch = true) {
    // Get branch name before removing worktree
    let branchToDelete = null;
    if (deleteBranch) {
        const worktrees = listWorktrees(projectRoot);
        const worktree = worktrees.find((w) => w.path === worktreePath);
        if (worktree?.branch) {
            branchToDelete = worktree.branch;
        }
    }
    if ((0, fs_1.existsSync)(worktreePath)) {
        await execAsync(`git worktree remove "${worktreePath}" --force`, {
            cwd: projectRoot,
        });
    }
    // Delete the branch after worktree is removed
    if (branchToDelete) {
        try {
            await execAsync(`git branch -D "${branchToDelete}"`, {
                cwd: projectRoot,
            });
            console.log(`Deleted branch: ${branchToDelete}`);
        }
        catch (e) {
            console.error(`Failed to delete branch ${branchToDelete}:`, e);
        }
    }
}
/**
 * List all worktrees
 */
function listWorktrees(projectRoot) {
    const output = (0, child_process_1.execSync)("git worktree list --porcelain", {
        cwd: projectRoot,
        encoding: "utf-8",
    });
    const worktrees = [];
    const entries = output.split("\n\n").filter(Boolean);
    for (const entry of entries) {
        const lines = entry.split("\n");
        const pathLine = lines.find((l) => l.startsWith("worktree "));
        const commitLine = lines.find((l) => l.startsWith("HEAD "));
        const branchLine = lines.find((l) => l.startsWith("branch "));
        if (pathLine) {
            worktrees.push({
                path: pathLine.replace("worktree ", ""),
                commit: commitLine?.replace("HEAD ", "") || "",
                branch: branchLine?.replace("branch refs/heads/", "") || "",
            });
        }
    }
    return worktrees;
}
/**
 * Check if a branch exists
 */
async function checkBranchExists(projectRoot, branch) {
    try {
        await execAsync(`git rev-parse --verify "${branch}"`, { cwd: projectRoot });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Merge a branch into main
 */
async function mergeBranch(projectRoot, branch, description, onConflict = "agent", config) {
    const mergeConfig = config?.merge || schema_js_1.DEFAULT_CONFIG.merge;
    const mainBranch = mergeConfig.mainBranch;
    const remote = mergeConfig.remote;
    // Checkout main and pull (if remote exists)
    if (remote) {
        await execAsync(`git checkout ${mainBranch} && git pull ${remote} ${mainBranch}`, { cwd: projectRoot });
    }
    else {
        await execAsync(`git checkout ${mainBranch}`, { cwd: projectRoot });
    }
    // Try to merge
    let mergeStrategy = "";
    if (onConflict === "auto_theirs") {
        mergeStrategy = "-X theirs";
    }
    else if (onConflict === "auto_ours") {
        mergeStrategy = "-X ours";
    }
    try {
        const { stdout } = await execAsync(`git merge --no-ff ${mergeStrategy} "${branch}" -m "merge: ${branch} - ${description}"`, { cwd: projectRoot });
        // Get commit hash
        const { stdout: hash } = await execAsync("git rev-parse HEAD", {
            cwd: projectRoot,
        });
        return {
            success: true,
            commitHash: hash.trim(),
            hasConflicts: false,
        };
    }
    catch (error) {
        // Check for conflicts
        const { stdout: status } = await execAsync("git status --porcelain", {
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
        throw error;
    }
}
/**
 * Abort a merge in progress
 */
async function abortMerge(projectRoot) {
    await execAsync("git merge --abort", { cwd: projectRoot });
}
/**
 * Get list of conflict files
 */
async function getConflictFiles(projectRoot) {
    const { stdout } = await execAsync("git diff --name-only --diff-filter=U", { cwd: projectRoot });
    return stdout.split("\n").filter(Boolean);
}
