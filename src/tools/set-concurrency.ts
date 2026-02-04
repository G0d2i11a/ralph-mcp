import { z } from "zod";
import { getRunnerConfig, setRunnerMaxConcurrency } from "../store/state.js";

export const setConcurrencyInputSchema = z.object({
  maxConcurrent: z
    .number()
    .int()
    .min(1)
    .max(10)
    .describe("Maximum concurrent PRD executions (1-10)"),
  reason: z
    .string()
    .optional()
    .describe("Optional reason for changing concurrency"),
});

export type SetConcurrencyInput = z.infer<typeof setConcurrencyInputSchema>;

export interface SetConcurrencyResult {
  success: boolean;
  previousConcurrency: number;
  newConcurrency: number;
  message: string;
}

/**
 * Set the maximum concurrency for the Runner at runtime.
 * Writes to state file that the Runner polls and applies.
 */
export async function setConcurrency(
  input: SetConcurrencyInput
): Promise<SetConcurrencyResult> {
  const previousConfig = await getRunnerConfig();
  const previousConcurrency = previousConfig.maxConcurrency;

  const newConfig = await setRunnerMaxConcurrency(
    input.maxConcurrent,
    input.reason
  );

  return {
    success: true,
    previousConcurrency,
    newConcurrency: newConfig.maxConcurrency,
    message: input.reason
      ? `Concurrency set to ${newConfig.maxConcurrency} (${input.reason}). Runner will apply on next poll cycle.`
      : `Concurrency set to ${newConfig.maxConcurrency}. Runner will apply on next poll cycle.`,
  };
}
