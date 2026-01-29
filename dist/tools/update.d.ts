import { z } from "zod";
export declare const updateInputSchema: z.ZodObject<{
    branch: z.ZodString;
    storyId: z.ZodString;
    passes: z.ZodBoolean;
    notes: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    branch: string;
    storyId: string;
    passes: boolean;
    notes?: string | undefined;
}, {
    branch: string;
    storyId: string;
    passes: boolean;
    notes?: string | undefined;
}>;
export type UpdateInput = z.infer<typeof updateInputSchema>;
export interface UpdateResult {
    success: boolean;
    branch: string;
    storyId: string;
    passes: boolean;
    allComplete: boolean;
    progress: string;
    addedToMergeQueue: boolean;
}
export declare function update(input: UpdateInput): Promise<UpdateResult>;
