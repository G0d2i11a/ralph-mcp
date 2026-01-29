import { z } from "zod";
export declare const mergeInputSchema: z.ZodObject<{
    branch: z.ZodString;
    force: z.ZodDefault<z.ZodBoolean>;
    skipQualityChecks: z.ZodDefault<z.ZodBoolean>;
    onConflict: z.ZodOptional<z.ZodEnum<["auto_theirs", "auto_ours", "notify", "agent"]>>;
}, "strip", z.ZodTypeAny, {
    branch: string;
    force: boolean;
    skipQualityChecks: boolean;
    onConflict?: "auto_theirs" | "auto_ours" | "notify" | "agent" | undefined;
}, {
    branch: string;
    onConflict?: "auto_theirs" | "auto_ours" | "notify" | "agent" | undefined;
    force?: boolean | undefined;
    skipQualityChecks?: boolean | undefined;
}>;
export type MergeInput = z.infer<typeof mergeInputSchema>;
export interface MergeResult {
    success: boolean;
    branch: string;
    commitHash?: string;
    cleanedUp: boolean;
    conflictResolution?: "auto" | "agent" | "pending";
    qualityChecks?: {
        typeCheck: boolean;
        build: boolean;
    };
    docsUpdated?: string[];
    mergedStories?: string[];
    message: string;
}
export declare function merge(input: MergeInput): Promise<MergeResult>;
export declare const mergeQueueInputSchema: z.ZodObject<{
    action: z.ZodDefault<z.ZodEnum<["list", "add", "remove", "process"]>>;
    branch: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    action: "list" | "add" | "remove" | "process";
    branch?: string | undefined;
}, {
    branch?: string | undefined;
    action?: "list" | "add" | "remove" | "process" | undefined;
}>;
export type MergeQueueInput = z.infer<typeof mergeQueueInputSchema>;
export interface MergeQueueResult {
    queue: string[];
    current?: string;
    message: string;
}
export declare function mergeQueueAction(input: MergeQueueInput): Promise<MergeQueueResult>;
