import { z } from "zod";
export declare const setAgentIdInputSchema: z.ZodObject<{
    branch: z.ZodString;
    agentTaskId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    branch: string;
    agentTaskId: string;
}, {
    branch: string;
    agentTaskId: string;
}>;
export type SetAgentIdInput = z.infer<typeof setAgentIdInputSchema>;
export interface SetAgentIdResult {
    success: boolean;
    branch: string;
    agentTaskId: string;
}
export declare function setAgentId(input: SetAgentIdInput): Promise<SetAgentIdResult>;
