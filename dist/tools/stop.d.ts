import { z } from "zod";
export declare const stopInputSchema: z.ZodObject<{
    branch: z.ZodString;
    cleanup: z.ZodDefault<z.ZodBoolean>;
    deleteRecord: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    branch: string;
    cleanup: boolean;
    deleteRecord: boolean;
}, {
    branch: string;
    cleanup?: boolean | undefined;
    deleteRecord?: boolean | undefined;
}>;
export type StopInput = z.infer<typeof stopInputSchema>;
export interface StopResult {
    success: boolean;
    branch: string;
    previousStatus: string;
    cleanedUp: boolean;
    deleted: boolean;
    message: string;
}
export declare function stop(input: StopInput): Promise<StopResult>;
