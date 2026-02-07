import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { openSync, closeSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { LaunchResult, AgentLauncher } from "../runner.js";
import { RALPH_DATA_DIR } from "../store/state.js";

export interface CodexLauncherConfig {
  /** Path to Codex CLI executable (default: "codex") */
  codexPath?: string;
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
  /** Timeout for launch confirmation in ms (default: 30000) */
  launchTimeout?: number;
}

/**
 * Codex CLI Agent Launcher
 *
 * Launches Codex agents using the Codex CLI with:
 * - `--non-interactive` flag for autonomous operation
 * - `--approval-policy` for command execution control
 * - `--sandbox-mode` for filesystem access control
 *
 * The launcher spawns the process detached so it continues running
 * independently of the Runner process.
 */
export class CodexLauncher implements AgentLauncher {
  private config: Required<Omit<CodexLauncherConfig, "onLog">> & Pick<CodexLauncherConfig, "onLog">;

  constructor(config: CodexLauncherConfig = {}) {
    this.config = {
      codexPath: config.codexPath ?? "codex",
      approvalPolicy: config.approvalPolicy ?? "on-request",
      sandboxMode: config.sandboxMode ?? "workspace-write",
      level: config.level ?? "L2",
      maxRecoveryAttempts: config.maxRecoveryAttempts ?? 2,
      stallTimeoutMinutes: config.stallTimeoutMinutes ?? 5,
      launchTimeout: config.launchTimeout ?? 30000,
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
      // Build command arguments
      const args = [
        "--non-interactive",
        "--approval-policy", this.config.approvalPolicy,
        "--sandbox-mode", this.config.sandboxMode,
        "--level", this.config.level,
        "--max-recovery-attempts", String(this.config.maxRecoveryAttempts),
        "--stall-timeout-minutes", String(this.config.stallTimeoutMinutes),
        prompt,
      ];

      this.log("info", `Launching Codex CLI in ${cwd}`);
      this.log("info", `Command: ${this.config.codexPath} ${args.join(" ")}`);
      this.log("info", `Log file: ${logPath}`);

      // Open log file for writing
      const logFd = openSync(logPath, "a");

      // Spawn Codex process
      const child = spawn(this.config.codexPath, args, {
        cwd,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        shell: false,
      });

      // Wait for process to start
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Codex launch timeout after ${this.config.launchTimeout}ms`));
        }, this.config.launchTimeout);

        child.on("spawn", () => {
          clearTimeout(timeout);
          this.log("info", `Codex process spawned with PID ${child.pid}`);
          resolve();
        });

        child.on("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });

        // If process exits immediately, that's an error
        child.on("exit", (code, signal) => {
          clearTimeout(timeout);
          if (code !== 0) {
            reject(new Error(`Codex exited immediately with code ${code} signal ${signal}`));
          }
        });
      });

      // Detach the process so it continues running independently
      child.unref();

      // Close our reference to the log file
      closeSync(logFd);

      this.log("info", `Codex agent launched successfully: ${agentTaskId}`);

      return {
        success: true,
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
