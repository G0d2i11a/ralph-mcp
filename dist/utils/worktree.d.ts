export interface WorktreeInfo {
    path: string;
    branch: string;
    commit: string;
}
/**
 * Create a new git worktree for a branch
 */
export declare function createWorktree(projectRoot: string, branch: string): Promise<string>;
/**
 * Remove a git worktree and optionally delete the branch
 */
export declare function removeWorktree(projectRoot: string, worktreePath: string, deleteBranch?: boolean): Promise<void>;
/**
 * List all worktrees
 */
export declare function listWorktrees(projectRoot: string): WorktreeInfo[];
/**
 * Merge a branch into main
 */
export declare function mergeBranch(projectRoot: string, branch: string, description: string, onConflict?: "auto_theirs" | "auto_ours" | "notify" | "agent"): Promise<{
    success: boolean;
    commitHash?: string;
    hasConflicts: boolean;
    conflictFiles?: string[];
}>;
/**
 * Abort a merge in progress
 */
export declare function abortMerge(projectRoot: string): Promise<void>;
/**
 * Get list of conflict files
 */
export declare function getConflictFiles(projectRoot: string): Promise<string[]>;
