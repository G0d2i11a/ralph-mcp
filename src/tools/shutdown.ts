import { z } from "zod";

export const shutdownInputSchema = z.object({
  reason: z.string().optional().describe("Optional reason for shutdown"),
  force: z.boolean().default(false).describe("Force shutdown even if PRDs are running"),
});

export type ShutdownInput = z.infer<typeof shutdownInputSchema>;

export interface ShutdownResult {
  success: boolean;
  message: string;
  runningPrds?: number;
}

// This will be set by index.ts to provide the shutdown callback
let shutdownCallback: ((reason?: string) => void) | null = null;

export function setShutdownCallback(callback: (reason?: string) => void): void {
  shutdownCallback = callback;
}

export async function shutdown(input: ShutdownInput): Promise<ShutdownResult> {
  // Import here to avoid circular dependency
  const { listExecutions } = await import("../store/state.js");

  const executions = await listExecutions();
  const running = executions.filter((e) => e.status === "running");

  if (running.length > 0 && !input.force) {
    return {
      success: false,
      message: `Cannot shutdown: ${running.length} PRD(s) are still running. Use force=true to shutdown anyway.`,
      runningPrds: running.length,
    };
  }

  const reason = input.reason || "Manual shutdown via ralph_shutdown";

  if (shutdownCallback) {
    // Schedule shutdown after response is sent
    setTimeout(() => {
      shutdownCallback!(reason);
    }, 100);
  }

  return {
    success: true,
    message: `Ralph MCP Server shutting down. Reason: ${reason}`,
    runningPrds: running.length,
  };
}
