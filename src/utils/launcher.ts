import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { openSync, closeSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { Provider } from "../agent-sdk/types.js";
import { getConfig } from "../config/loader.js";
import type { LaunchResult, AgentLauncher } from "../runner.js";
import { RALPH_DATA_DIR } from "../store/state.js";
import { createCodexLauncher, type CodexLauncherConfig } from "./codex-launcher.js";
import { createSdkLauncher, type SdkLauncherConfig } from "./sdk-launcher.js";

export type AgentBackend = "cli" | "sdk";

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

export interface ResolvedAgentLaunchConfig {
  backend: AgentBackend;
  provider: Provider;
  claude: Required<Pick<LauncherConfig, "claudePath" | "additionalFlags">>;
  codex: Required<Pick<CodexLauncherConfig, "codexPath" | "approvalPolicy" | "sandboxMode" | "level" | "maxRecoveryAttempts" | "stallTimeoutMinutes">>;
}

export interface MultiBackendLauncherConfig {
  defaultBackend?: AgentBackend;
  defaultProvider?: Provider;
  launchTimeout?: number;
  sdkFallback?: boolean;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
  claude?: Pick<LauncherConfig, "claudePath" | "additionalFlags">;
  codex?: Pick<CodexLauncherConfig, "codexPath" | "approvalPolicy" | "sandboxMode" | "level" | "maxRecoveryAttempts" | "stallTimeoutMinutes">;
}

export interface LauncherFactoryOverrides {
  createClaudeCliLauncher?: (config: LauncherConfig) => AgentLauncher;
  createCodexCliLauncher?: (config: CodexLauncherConfig) => AgentLauncher;
  createSdkFallbackLauncher?: (config: SdkLauncherConfig) => AgentLauncher;
}

export function resolveAgentLaunchConfig(
  projectRoot: string,
  defaults: Pick<MultiBackendLauncherConfig, "defaultBackend" | "defaultProvider" | "claude" | "codex"> = {}
): ResolvedAgentLaunchConfig {
  const agentConfig = getConfig(projectRoot).agent;

  return {
    backend: agentConfig.backend ?? defaults.defaultBackend ?? "cli",
    provider: agentConfig.provider ?? defaults.defaultProvider ?? "codex",
    claude: {
      claudePath: defaults.claude?.claudePath ?? agentConfig.claude.claudePath,
      additionalFlags: defaults.claude?.additionalFlags ?? agentConfig.claude.additionalFlags,
    },
    codex: {
      codexPath: defaults.codex?.codexPath ?? agentConfig.codex.codexPath,
      approvalPolicy: defaults.codex?.approvalPolicy ?? agentConfig.codex.approvalPolicy,
      sandboxMode: defaults.codex?.sandboxMode ?? agentConfig.codex.sandboxMode,
      level: defaults.codex?.level ?? agentConfig.codex.level,
      maxRecoveryAttempts:
        defaults.codex?.maxRecoveryAttempts ?? agentConfig.codex.maxRecoveryAttempts,
      stallTimeoutMinutes:
        defaults.codex?.stallTimeoutMinutes ?? agentConfig.codex.stallTimeoutMinutes,
    },
  };
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

export class MultiBackendLauncher implements AgentLauncher {
  private readonly config: Required<Pick<MultiBackendLauncherConfig, "defaultBackend" | "defaultProvider" | "launchTimeout" | "sdkFallback">> & MultiBackendLauncherConfig;
  private readonly sdkLauncher: AgentLauncher;
  private readonly factories: Required<LauncherFactoryOverrides>;

  constructor(
    config: MultiBackendLauncherConfig = {},
    factoryOverrides: LauncherFactoryOverrides = {}
  ) {
    this.config = {
      defaultBackend: config.defaultBackend ?? "cli",
      defaultProvider: config.defaultProvider ?? "codex",
      launchTimeout: config.launchTimeout ?? 30_000,
      sdkFallback: config.sdkFallback ?? true,
      ...config,
    };

    this.factories = {
      createClaudeCliLauncher: factoryOverrides.createClaudeCliLauncher
        ?? ((launcherConfig) => new ClaudeLauncher(launcherConfig)),
      createCodexCliLauncher: factoryOverrides.createCodexCliLauncher
        ?? ((launcherConfig) => createCodexLauncher(launcherConfig)),
      createSdkFallbackLauncher: factoryOverrides.createSdkFallbackLauncher
        ?? ((launcherConfig) => createSdkLauncher(launcherConfig)),
    };

    this.sdkLauncher = this.factories.createSdkFallbackLauncher({
      defaultProvider: this.config.defaultProvider,
      launchTimeout: this.config.launchTimeout,
      onLog: this.config.onLog,
      codex: this.config.codex,
    });
  }

  async launch(prompt: string, cwd: string, executionId?: string): Promise<LaunchResult> {
    const resolved = resolveAgentLaunchConfig(cwd, {
      defaultBackend: this.config.defaultBackend,
      defaultProvider: this.config.defaultProvider,
      claude: this.config.claude,
      codex: this.config.codex,
    });

    const primaryLauncher = this.createPrimaryLauncher(resolved);
    const primaryResult = await primaryLauncher.launch(prompt, cwd, executionId);

    if (primaryResult.success || resolved.backend !== "cli" || !this.config.sdkFallback) {
      return primaryResult;
    }

    this.log(
      "warn",
      `CLI ${resolved.provider} launch failed${primaryResult.error ? `: ${primaryResult.error}` : ""}; falling back to SDK backend`
    );

    const fallbackResult = await this.sdkLauncher.launch(prompt, cwd, executionId);
    if (fallbackResult.success) {
      return fallbackResult;
    }

    return {
      success: false,
      error: [
        primaryResult.error ? `CLI launch failed: ${primaryResult.error}` : "CLI launch failed",
        fallbackResult.error
          ? `SDK fallback failed: ${fallbackResult.error}`
          : "SDK fallback failed",
      ].join("; "),
    };
  }

  private createPrimaryLauncher(resolved: ResolvedAgentLaunchConfig): AgentLauncher {
    if (resolved.backend === "sdk") {
      return this.sdkLauncher;
    }

    if (resolved.provider === "claude") {
      return this.factories.createClaudeCliLauncher({
        claudePath: resolved.claude.claudePath,
        additionalFlags: resolved.claude.additionalFlags,
        launchTimeout: this.config.launchTimeout,
        onLog: this.config.onLog,
      });
    }

    return this.factories.createCodexCliLauncher({
      codexPath: resolved.codex.codexPath,
      approvalPolicy: resolved.codex.approvalPolicy,
      sandboxMode: resolved.codex.sandboxMode,
      level: resolved.codex.level,
      maxRecoveryAttempts: resolved.codex.maxRecoveryAttempts,
      stallTimeoutMinutes: resolved.codex.stallTimeoutMinutes,
      launchTimeout: this.config.launchTimeout,
      onLog: this.config.onLog,
    });
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    if (this.config.onLog) {
      this.config.onLog(level, message);
    }
  }
}

export function createClaudeLauncher(config: LauncherConfig = {}): AgentLauncher {
  return new ClaudeLauncher(config);
}

export function createLauncher(
  config: MultiBackendLauncherConfig = {},
  factoryOverrides: LauncherFactoryOverrides = {}
): AgentLauncher {
  return new MultiBackendLauncher(config, factoryOverrides);
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
