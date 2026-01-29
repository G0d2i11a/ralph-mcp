/**
 * Generate agent prompt for PRD execution
 */
export declare function generateAgentPrompt(branch: string, description: string, worktreePath: string, stories: Array<{
    storyId: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    priority: number;
    passes: boolean;
}>): string;
/**
 * Generate merge agent prompt for conflict resolution
 */
export declare function generateMergeAgentPrompt(projectRoot: string, branch: string, description: string, conflictFiles: string[], prdPath?: string): string;
/**
 * Start a Claude agent via CLI (for merge conflicts)
 */
export declare function startMergeAgent(projectRoot: string, prompt: string): Promise<{
    success: boolean;
    output: string;
}>;
