import { randomUUID } from "crypto";
import { mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import type { LaunchResult, AgentLauncher } from "../runner.js";
import { RALPH_DATA_DIR } from "../store/state.js";

export interface CodexLauncherConfig {
  /** Callback for logging */
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
  /** Approval policy for commands */
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  /** Sandbox mode for command execution */
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  /** Execution level */
  level?: "L1" | "L2" | "L3" | "L4";
  /** Max recovery attempts when stalled */
  maxRecoveryAttempts?: number;
  /** Minutes of inactivity before detecting stall */
  stallTimeoutMinutes?: number;
}

/**
 * Codex MCP Agent Launcher
 *
 * Launches Codex agents using the Codex MCP server.
 * This is a placeholder implementation that would need to integrate
 * with the actual MCP client to call mcp__subcodex__run.
 */
export class CodexLauncher implements AgentLauncher {
  private config: Required<Omit<CodexLauncherConfig, "onLog">> & Pick<CodexLauncherConfig, "onLog">;

  constructor(config: CodexLauncherConfig = {}) {
    this.config = {
      approvalPolicy: config.approvalPolicy ?? "on-request",
      sandboxMode: config.sandboxMode ?? "workspace-write",
      level: config.level ?? "L2",
      maxRecoveryAttempts: config.maxRecoveryAttempts ?? 2,
      stallTimeoutMinutes: config.stallTimeoutMinutes ?? 5,
      onLog: config.onLog,
    };
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    if (this.config.onLog) {
      this.config.onLog(level, message);
    }
  }

  /**
   * Launch a Codex agent with the given prompt.
   *
   * @param prompt - The agent prompt to execute
   * @param cwd - Working directory for the agent
   * @param executionId - Optional execution ID for log file naming
   * @returns LaunchResult with success status and agent task ID
   */
  async launch(prompt: string, cwd: string, executionId?: string): Promise<LaunchResult> {
    // Generate a unique task ID for tracking
    const agentTaskId = `ralph-codex-${randomUUID().slice(0, 8)}`;

    // Create logs directory if needed
    const logsDir = join(RALPH_DATA_DIR, "logs");
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }

    // Create log file for this execution
    const logFileName = executionId ? `${executionId}.jsonl` : `${agentTaskId}.jsonl`;
    const logPath = join(logsDir, logFileName);

    try {
      this.log("info", `Launching Codex agent in ${cwd}`);
      this.log("info", `Task ID: ${agentTaskId}`);
      this.log("info", `Log file: ${logPath}`);

      // TODO: This is a placeholder implementation.
      // In a real implementation, we would need to:
      // 1. Get access to the MCP client
      // 2. Call mcp__subcodex__run with the prompt
      // 3. Monitor the Codex session for completion
      // 4. Stream output to the log file
      //
      // For now, we'll return an error indicating this needs implementation.

      this.log("error", "Codex launcher is not yet fully implemented");
      this.log("error", "This requires integration with the MCP client to call mcp__subcodex__run");

      // Write a placeholder log entry
      writeFileSync(logPath, JSON.stringify({
        type: "error",
        timestamp: new Date().toISOString(),
        message: "Codex launcher not yet implemented",
        agentTaskId,
      }) + "\n");

      return {
        success: false,
        error: "Codex launcher not yet implemented. This requires MCP client integration.",
        agentTaskId,
        logPath,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log("error", `Failed to launch Codex agent: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
        agentTaskId,
        logPath,
      };
    }
  }
}

/**
 * Create a Codex launcher instance.
 */
export function createCodexLauncher(config: CodexLauncherConfig = {}): AgentLauncher {
  return new CodexLauncher(config);
}
