import { z } from "zod";
export declare const startInputSchema: z.ZodObject<{
    prdPath: z.ZodString;
    projectRoot: z.ZodOptional<z.ZodString>;
    worktree: z.ZodDefault<z.ZodBoolean>;
    autoStart: z.ZodDefault<z.ZodBoolean>;
    autoMerge: z.ZodDefault<z.ZodBoolean>;
    notifyOnComplete: z.ZodDefault<z.ZodBoolean>;
    onConflict: z.ZodDefault<z.ZodEnum<["auto_theirs", "auto_ours", "notify", "agent"]>>;
}, "strip", z.ZodTypeAny, {
    prdPath: string;
    onConflict: "auto_theirs" | "auto_ours" | "notify" | "agent";
    autoMerge: boolean;
    notifyOnComplete: boolean;
    worktree: boolean;
    autoStart: boolean;
    projectRoot?: string | undefined;
}, {
    prdPath: string;
    projectRoot?: string | undefined;
    onConflict?: "auto_theirs" | "auto_ours" | "notify" | "agent" | undefined;
    autoMerge?: boolean | undefined;
    notifyOnComplete?: boolean | undefined;
    worktree?: boolean | undefined;
    autoStart?: boolean | undefined;
}>;
export type StartInput = z.infer<typeof startInputSchema>;
export interface StartResult {
    executionId: string;
    branch: string;
    worktreePath: string | null;
    agentPrompt: string | null;
    stories: Array<{
        storyId: string;
        title: string;
        description: string;
        acceptanceCriteria: string[];
        priority: number;
        passes: boolean;
    }>;
}
export declare function start(input: StartInput): Promise<StartResult>;
