import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { openSync, closeSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { LaunchResult, AgentLauncher } from "../runner.js";
import { RALPH_DATA_DIR } from "../store/state.js";

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
   * @param executionId - Optional execution ID for log file naming
   * @returns LaunchResult with success status and agent task ID
   */
  async launch(prompt: string, cwd: string, executionId?: string): Promise<LaunchResult> {
    // Generate a unique task ID for tracking
    const agentTaskId = `ralph-agent-${randomUUID().slice(0, 8)}`;

    // Create logs directory if needed
    const logsDir = join(RALPH_DATA_DIR, "logs");
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }

    // Create log file for this execution
    const logFileName = executionId ? `${executionId}.jsonl` : `${agentTaskId}.jsonl`;
    const logPath = join(logsDir, logFileName);

    try {
      // Build command arguments - use stream-json for real-time output
      const args = [
        "--print",
        "--verbose",  // Required for stream-json output format
        "--dangerously-skip-permissions",
        "--output-format", "stream-json",
        ...this.config.additionalFlags,
      ];

      this.log("info", `Launching Claude CLI in ${cwd}`);
      this.log("info", `Command: ${this.config.claudePath} ${args.join(" ")}`);
      this.log("info", `Log file: ${logPath}`);

      // Open log file for writing
      const logFd = openSync(logPath, "a");

      // Determine git-bash path for Windows
      const gitBashPath = process.env.CLAUDE_CODE_GIT_BASH_PATH
        || (existsSync("D:\\Software\\Git\\bin\\bash.exe") ? "D:\\Software\\Git\\bin\\bash.exe" : null)
        || (existsSync("C:\\Program Files\\Git\\bin\\bash.exe") ? "C:\\Program Files\\Git\\bin\\bash.exe" : null)
        || "bash.exe";  // Fallback to PATH

      this.log("info", `Git bash path: ${gitBashPath}`);

      // On Windows, we need to run Claude through git-bash
      // Build the command to run in bash
      const isWindows = process.platform === "win32";
      let child;

      if (isWindows && gitBashPath) {
        // Run claude through git-bash on Windows
        // NOTE: Claude CLI expects CLAUDE_CODE_GIT_BASH_PATH to be visible inside the bash session.
        // Passing it only via spawn({ env }) is not reliably visible when invoking via `bash -c`,
        // so export it directly in the command we pass to bash.
        //
        // IMPORTANT: When using `bash -c`, stdin goes to bash, not to the command inside.
        // We need to use `cat | claude` to pipe stdin through to claude.
        const escapedGitBashPath = gitBashPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const claudeCmd = `export CLAUDE_CODE_GIT_BASH_PATH="${escapedGitBashPath}" && cat | ${this.config.claudePath} ${args.map(a => `"${a}"`).join(" ")}`;
        child = spawn(gitBashPath, ["-c", claudeCmd], {
          cwd,
          stdio: ["pipe", logFd, logFd],  // stdin: pipe, stdout/stderr: log file
          detached: true, // Run independently of parent
          env: {
            ...process.env,
            CLAUDE_CODE_GIT_BASH_PATH: gitBashPath,
          },
        });
      } else {
        // On non-Windows, spawn directly
        child = spawn(this.config.claudePath, args, {
          cwd,
          stdio: ["pipe", logFd, logFd],
          detached: true,
          env: process.env,
        });
      }

      // Write prompt to stdin
      if (child.stdin) {
        child.stdin.write(prompt);
        child.stdin.end();
      }

      // Wait for process to start (or fail quickly)
      const startResult = await this.waitForStart(child, agentTaskId, logPath);

      // Close log fd in parent process (child keeps writing)
      closeSync(logFd);

      if (!startResult.success) {
        return startResult;
      }

      // Unref the child so it doesn't keep the parent alive
      child.unref();

      this.log("info", `Agent launched successfully: ${agentTaskId} (PID: ${child.pid})`);

      return {
        success: true,
        agentTaskId,
        logPath,
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
    agentTaskId: string,
    logPath: string
  ): Promise<LaunchResult> {
    return new Promise((resolve) => {
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          // Process is still running after timeout - consider it started
          resolve({ success: true, agentTaskId, logPath });
        }
      }, this.config.launchTimeout);

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
            resolve({ success: true, agentTaskId, logPath });
          } else {
            resolve({
              success: false,
              error: `Process exited with code ${code}${signal ? ` (signal: ${signal})` : ""}`,
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
          resolve({ success: true, agentTaskId, logPath });
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
