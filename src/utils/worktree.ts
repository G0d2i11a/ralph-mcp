import { execSync, exec } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
}

/**
 * Create a new git worktree for a branch
 */
export async function createWorktree(
  projectRoot: string,
  branch: string
): Promise<string> {
  // Extract short name from branch (ralph/task1-agent -> task1-agent)
  const shortName = branch.replace(/^ralph\//, "");
  const worktreePath = join(projectRoot, ".tmp", "worktrees", `ralph-${shortName}`);

  // Check if worktree already exists
  if (existsSync(worktreePath)) {
    console.log(`Worktree already exists at ${worktreePath}`);
    return worktreePath;
  }

  // Check if branch exists
  const branchExists = await checkBranchExists(projectRoot, branch);

  if (branchExists) {
    // Worktree for existing branch
    await execAsync(
      `git worktree add "${worktreePath}" "${branch}"`,
      { cwd: projectRoot }
    );
  } else {
    // Create new branch from main
    await execAsync(
      `git worktree add -b "${branch}" "${worktreePath}" main`,
      { cwd: projectRoot }
    );
  }

  return worktreePath;
}

/**
 * Remove a git worktree and optionally delete the branch
 */
export async function removeWorktree(
  projectRoot: string,
  worktreePath: string,
  deleteBranch: boolean = true
): Promise<void> {
  // Get branch name before removing worktree
  let branchToDelete: string | null = null;
  if (deleteBranch) {
    const worktrees = listWorktrees(projectRoot);
    const worktree = worktrees.find((w) => w.path === worktreePath);
    if (worktree?.branch) {
      branchToDelete = worktree.branch;
    }
  }

  if (existsSync(worktreePath)) {
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
    } catch (e) {
      console.error(`Failed to delete branch ${branchToDelete}:`, e);
    }
  }
}

/**
 * List all worktrees
 */
export function listWorktrees(projectRoot: string): WorktreeInfo[] {
  const output = execSync("git worktree list --porcelain", {
    cwd: projectRoot,
    encoding: "utf-8",
  });

  const worktrees: WorktreeInfo[] = [];
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
async function checkBranchExists(
  projectRoot: string,
  branch: string
): Promise<boolean> {
  try {
    await execAsync(`git rev-parse --verify "${branch}"`, { cwd: projectRoot });
    return true;
  } catch {
    return false;
  }
}

/**
 * Merge a branch into main
 */
export async function mergeBranch(
  projectRoot: string,
  branch: string,
  description: string,
  onConflict: "auto_theirs" | "auto_ours" | "notify" | "agent" = "agent"
): Promise<{
  success: boolean;
  commitHash?: string;
  hasConflicts: boolean;
  conflictFiles?: string[];
}> {
  // Checkout main and pull
  await execAsync("git checkout main && git pull", { cwd: projectRoot });

  // Try to merge
  let mergeStrategy = "";
  if (onConflict === "auto_theirs") {
    mergeStrategy = "-X theirs";
  } else if (onConflict === "auto_ours") {
    mergeStrategy = "-X ours";
  }

  try {
    const { stdout } = await execAsync(
      `git merge --no-ff ${mergeStrategy} "${branch}" -m "merge: ${branch} - ${description}"`,
      { cwd: projectRoot }
    );

    // Get commit hash
    const { stdout: hash } = await execAsync("git rev-parse HEAD", {
      cwd: projectRoot,
    });

    return {
      success: true,
      commitHash: hash.trim(),
      hasConflicts: false,
    };
  } catch (error) {
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
export async function abortMerge(projectRoot: string): Promise<void> {
  await execAsync("git merge --abort", { cwd: projectRoot });
}

/**
 * Get list of conflict files
 */
export async function getConflictFiles(projectRoot: string): Promise<string[]> {
  const { stdout } = await execAsync(
    "git diff --name-only --diff-filter=U",
    { cwd: projectRoot }
  );
  return stdout.split("\n").filter(Boolean);
}
