import { z } from "zod";
export declare const statusInputSchema: z.ZodObject<{
    project: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodEnum<["pending", "running", "completed", "failed", "stopped", "merging"]>>;
}, "strip", z.ZodTypeAny, {
    project?: string | undefined;
    status?: "pending" | "running" | "completed" | "failed" | "stopped" | "merging" | undefined;
}, {
    project?: string | undefined;
    status?: "pending" | "running" | "completed" | "failed" | "stopped" | "merging" | undefined;
}>;
export type StatusInput = z.infer<typeof statusInputSchema>;
export interface ExecutionStatus {
    branch: string;
    description: string;
    status: string;
    progress: string;
    completedStories: number;
    totalStories: number;
    worktreePath: string | null;
    agentTaskId: string | null;
    lastActivity: string;
    createdAt: string;
}
export interface StatusResult {
    executions: ExecutionStatus[];
    summary: {
        total: number;
        running: number;
        completed: number;
        failed: number;
        pending: number;
    };
}
export declare function status(input: StatusInput): Promise<StatusResult>;
