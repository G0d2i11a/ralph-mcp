import { exec } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
const execAsync = promisify(exec);
/**
 * Sync main branch to feature branch before merge
 */
export async function syncMainToBranch(worktreePath, branch) {
    try {
        // Check if origin remote exists
        let hasOrigin = false;
        try {
            const { stdout } = await execAsync("git remote", { cwd: worktreePath });
            hasOrigin = stdout.includes("origin");
        }
        catch {
            hasOrigin = false;
        }
        // Fetch latest main only if origin exists
        if (hasOrigin) {
            await execAsync("git fetch origin main", { cwd: worktreePath });
        }
        // Try to merge main into feature branch
        const mergeTarget = hasOrigin ? "origin/main" : "main";
        try {
            await execAsync(`git merge ${mergeTarget} --no-edit`, { cwd: worktreePath });
            return {
                success: true,
                hasConflicts: false,
                message: "Successfully synced main to feature branch",
            };
        }
        catch (mergeError) {
            // Check for conflicts
            const { stdout: status } = await execAsync("git status --porcelain", {
                cwd: worktreePath,
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
                    message: `Conflicts when syncing main: ${conflictFiles.join(", ")}`,
                };
            }
            throw mergeError;
        }
    }
    catch (error) {
        return {
            success: false,
            hasConflicts: false,
            message: `Failed to sync main: ${error}`,
        };
    }
}
/**
 * Run quality checks (type check and build)
 */
export async function runQualityChecks(worktreePath) {
    const result = {
        success: false,
        typeCheck: { success: false, output: "" },
        build: { success: false, output: "" },
    };
    // Run type check
    try {
        const { stdout, stderr } = await execAsync("pnpm check-types", {
            cwd: worktreePath,
            timeout: 120000, // 2 minutes
        });
        result.typeCheck = { success: true, output: stdout || stderr };
    }
    catch (error) {
        const execError = error;
        result.typeCheck = {
            success: false,
            output: execError.stdout || execError.stderr || String(error),
        };
        return result;
    }
    // Run build (only API for now, as it's the critical one)
    try {
        const { stdout, stderr } = await execAsync("pnpm --filter api build", {
            cwd: worktreePath,
            timeout: 180000, // 3 minutes
        });
        result.build = { success: true, output: stdout || stderr };
    }
    catch (error) {
        const execError = error;
        result.build = {
            success: false,
            output: execError.stdout || execError.stderr || String(error),
        };
        return result;
    }
    result.success = true;
    return result;
}
/**
 * Generate commit message with US list
 */
export function generateCommitMessage(branch, description, completedStories) {
    const storyList = completedStories
        .map((s) => `- ${s.id}: ${s.title}`)
        .join("\n");
    return `merge: ${branch} - ${description}

Completed User Stories:
${storyList || "- No stories tracked"}

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>`;
}
/**
 * Get list of commits on branch since diverging from main
 */
export async function getBranchCommits(projectRoot, branch) {
    try {
        const { stdout } = await execAsync(`git log main..${branch} --oneline --no-merges`, { cwd: projectRoot });
        return stdout.split("\n").filter(Boolean);
    }
    catch {
        return [];
    }
}
/**
 * Update TODO.md to mark PRD as completed
 */
export function updateTodoDoc(projectRoot, branch, description) {
    const todoPath = join(projectRoot, "docs", "TODO.md");
    if (!existsSync(todoPath)) {
        return false;
    }
    try {
        let content = readFileSync(todoPath, "utf-8");
        // Find and update the PRD entry (mark as completed)
        // Pattern: - [ ] PRD description -> - [x] PRD description
        const prdPattern = new RegExp(`- \\[ \\] (.*${description.slice(0, 30)}.*|.*${branch}.*)`);
        if (prdPattern.test(content)) {
            content = content.replace(prdPattern, "- [x] $1");
            writeFileSync(todoPath, content, "utf-8");
            return true;
        }
        return false;
    }
    catch {
        return false;
    }
}
/**
 * Update PROJECT-STATUS.md with merge info
 */
export function updateProjectStatus(projectRoot, branch, description, commitHash) {
    const statusPath = join(projectRoot, "docs", "PROJECT-STATUS.md");
    if (!existsSync(statusPath)) {
        return false;
    }
    try {
        let content = readFileSync(statusPath, "utf-8");
        // Add to recent merges section or create one
        const date = new Date().toISOString().split("T")[0];
        const mergeEntry = `- ${date}: ${branch} - ${description} (${commitHash.slice(0, 7)})`;
        const recentMergesPattern = /## Recent Merges\n/;
        if (recentMergesPattern.test(content)) {
            content = content.replace(recentMergesPattern, `## Recent Merges\n${mergeEntry}\n`);
        }
        else {
            // Add section at the end
            content += `\n## Recent Merges\n${mergeEntry}\n`;
        }
        writeFileSync(statusPath, content, "utf-8");
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Handle schema.prisma conflicts specially
 */
export async function handleSchemaConflict(projectRoot) {
    const schemaPath = join(projectRoot, "apps", "api", "src", "infra", "prisma", "schema.prisma");
    if (!existsSync(schemaPath)) {
        return false;
    }
    try {
        // Read the conflicted file
        let content = readFileSync(schemaPath, "utf-8");
        // Check if there are conflict markers
        if (!content.includes("<<<<<<<") && !content.includes(">>>>>>>")) {
            return true; // No conflicts
        }
        // For schema.prisma, we typically want to keep both changes
        // Remove conflict markers and keep all content
        content = content
            .replace(/<<<<<<< HEAD\n/g, "")
            .replace(/=======\n/g, "")
            .replace(/>>>>>>> .+\n/g, "");
        // Remove duplicate model definitions (keep first occurrence)
        const modelPattern = /model (\w+) \{[\s\S]*?\n\}/g;
        const seenModels = new Set();
        content = content.replace(modelPattern, (match, modelName) => {
            if (seenModels.has(modelName)) {
                return ""; // Remove duplicate
            }
            seenModels.add(modelName);
            return match;
        });
        // Clean up extra blank lines
        content = content.replace(/\n{3,}/g, "\n\n");
        writeFileSync(schemaPath, content, "utf-8");
        // Stage the resolved file
        await execAsync(`git add "${schemaPath}"`, { cwd: projectRoot });
        return true;
    }
    catch {
        return false;
    }
}
