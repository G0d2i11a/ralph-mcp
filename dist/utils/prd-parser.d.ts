export interface ParsedUserStory {
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    priority: number;
}
export interface ParsedPrd {
    title: string;
    description: string;
    branchName: string;
    userStories: ParsedUserStory[];
}
/**
 * Parse a PRD markdown file into structured data.
 * Supports both markdown format and JSON format.
 */
export declare function parsePrdFile(filePath: string): ParsedPrd;
/**
 * Generate branch name from PRD title
 */
export declare function generateBranchName(title: string): string;
