export interface QualityCheckResult {
    success: boolean;
    typeCheck: {
        success: boolean;
        output: string;
    };
    build: {
        success: boolean;
        output: string;
    };
}
export interface SyncResult {
    success: boolean;
    hasConflicts: boolean;
    conflictFiles?: string[];
    message: string;
}
/**
 * Sync main branch to feature branch before merge
 */
export declare function syncMainToBranch(worktreePath: string, branch: string): Promise<SyncResult>;
/**
 * Run quality checks (type check and build)
 */
export declare function runQualityChecks(worktreePath: string): Promise<QualityCheckResult>;
/**
 * Generate commit message with US list
 */
export declare function generateCommitMessage(branch: string, description: string, completedStories: {
    id: string;
    title: string;
}[]): string;
/**
 * Get list of commits on branch since diverging from main
 */
export declare function getBranchCommits(projectRoot: string, branch: string): Promise<string[]>;
/**
 * Update TODO.md to mark PRD as completed
 */
export declare function updateTodoDoc(projectRoot: string, branch: string, description: string): boolean;
/**
 * Update PROJECT-STATUS.md with merge info
 */
export declare function updateProjectStatus(projectRoot: string, branch: string, description: string, commitHash: string): boolean;
/**
 * Handle schema.prisma conflicts specially
 */
export declare function handleSchemaConflict(projectRoot: string): Promise<boolean>;
