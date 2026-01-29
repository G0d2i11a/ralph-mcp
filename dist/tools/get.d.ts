import { z } from "zod";
export declare const getInputSchema: z.ZodObject<{
    branch: z.ZodString;
}, "strip", z.ZodTypeAny, {
    branch: string;
}, {
    branch: string;
}>;
export type GetInput = z.infer<typeof getInputSchema>;
export interface GetResult {
    execution: {
        id: string;
        project: string;
        branch: string;
        description: string;
        prdPath: string;
        projectRoot: string;
        worktreePath: string | null;
        status: string;
        agentTaskId: string | null;
        onConflict: string | null;
        createdAt: string;
        updatedAt: string;
    };
    stories: Array<{
        storyId: string;
        title: string;
        description: string;
        acceptanceCriteria: string[];
        priority: number;
        passes: boolean;
        notes: string | null;
    }>;
    progress: {
        completed: number;
        total: number;
        percentage: number;
    };
}
export declare function get(input: GetInput): Promise<GetResult>;
