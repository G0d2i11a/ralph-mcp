import { spawn } from "child_process";
import { randomUUID } from "crypto";
import type { LaunchResult, AgentLauncher } from "../runner.js";

export interface LauncherConfig {
  /** Path to Claude CLI executable (default: "claude") */
  claudePath?: string;
  /** Additional CLI flags */
  additionalFlags?: string[];
  /** Timeout for launch confirmation in ms (default: 30000) */
  launchTimeout?: number;
  /** Callback for logging */
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
}

/**
 * Claude CLI Agent Launcher
 *
 * Launches Claude agents using the Claude CLI with:
 * - `--print` flag for non-interactive output
 * - `--dangerously-skip-permissions` for autonomous operation
 *
 * The launcher spawns the process detached so it continues running
 * independently of the Runner process.
 */
export class ClaudeLauncher implements AgentLauncher {
  private config: Required<Omit<LauncherConfig, "onLog">> & Pick<LauncherConfig, "onLog">;

  constructor(config: LauncherConfig = {}) {
    this.config = {
      claudePath: config.claudePath ?? "claude",
      additionalFlags: config.additionalFlags ?? [],
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
   * Launch a Claude agent with the given prompt.
   *
   * @param prompt - The agent prompt to execute
   * @param cwd - Working directory for the agent
   * @returns LaunchResult with success status and agent task ID
   */
  async launch(prompt: string, cwd: string): Promise<LaunchResult> {
    // Generate a unique task ID for tracking
    const agentTaskId = `ralph-agent-${randomUUID().slice(0, 8)}`;

    try {
      // Build command arguments
      const args = [
        "--print",
        "--dangerously-skip-permissions",
        ...this.config.additionalFlags,
      ];

      this.log("info", `Launching Claude CLI in ${cwd}`);
      this.log("info", `Command: ${this.config.claudePath} ${args.join(" ")}`);

      // Spawn the Claude process
      const child = spawn(this.config.claudePath, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true, // Run independently of parent
        shell: process.platform === "win32", // Use shell on Windows for PATH resolution
      });

      // Write prompt to stdin
      if (child.stdin) {
        child.stdin.write(prompt);
        child.stdin.end();
      }

      // Wait for process to start (or fail quickly)
      const startResult = await this.waitForStart(child, agentTaskId);

      if (!startResult.success) {
        return startResult;
      }

      // Unref the child so it doesn't keep the parent alive
      child.unref();

      this.log("info", `Agent launched successfully: ${agentTaskId} (PID: ${child.pid})`);

      return {
        success: true,
        agentTaskId,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log("error", `Launch failed: ${errorMsg}`);

      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Wait for the process to start successfully or fail.
   */
  private waitForStart(
    child: ReturnType<typeof spawn>,
    agentTaskId: string
  ): Promise<LaunchResult> {
    return new Promise((resolve) => {
      let resolved = false;
      let stderrOutput = "";

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          // Process is still running after timeout - consider it started
          resolve({ success: true, agentTaskId });
        }
      }, this.config.launchTimeout);

      // Capture stderr for error messages
      if (child.stderr) {
        child.stderr.on("data", (data: Buffer) => {
          stderrOutput += data.toString();
        });
      }

      // Handle spawn errors
      child.on("error", (error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve({
            success: false,
            error: `Spawn error: ${error.message}`,
          });
        }
      });

      // Handle early exit (failure)
      child.on("exit", (code, signal) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);

          if (code === 0) {
            // Process completed successfully (unusual for long-running agent)
            resolve({ success: true, agentTaskId });
          } else {
            resolve({
              success: false,
              error: `Process exited with code ${code}${signal ? ` (signal: ${signal})` : ""}${stderrOutput ? `: ${stderrOutput.slice(0, 500)}` : ""}`,
            });
          }
        }
      });

      // If process has a PID, it started successfully
      // Give it a moment to potentially fail
      setTimeout(() => {
        if (!resolved && child.pid) {
          resolved = true;
          clearTimeout(timeout);
          resolve({ success: true, agentTaskId });
        }
      }, 1000);
    });
  }
}

/**
 * Create a mock launcher for testing.
 */
export function createMockLauncher(
  mockResult: LaunchResult = { success: true, agentTaskId: "mock-agent-123" }
): AgentLauncher {
  return {
    async launch(_prompt: string, _cwd: string): Promise<LaunchResult> {
      return mockResult;
    },
  };
}
