import { AgentInvocationRouter } from "../agent-sdk/router.js";
import type { AgentHandle, AgentResult, Provider } from "../agent-sdk/types.js";
import { getConfig } from "../config/loader.js";
import { listExecutions, updateExecution } from "../store/state.js";
import type { LaunchResult, AgentLauncher } from "../runner.js";

type LogLevel = "info" | "warn" | "error";
type CodexApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";
type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type CodexLevel = "L1" | "L2" | "L3" | "L4";

export interface SdkLauncherConfig {
  defaultProvider?: Provider;
  onLog?: (level: LogLevel, message: string) => void;
  launchTimeout?: number;
  codex?: {
    approvalPolicy?: CodexApprovalPolicy;
    sandboxMode?: CodexSandboxMode;
    level?: CodexLevel;
  };
}

export class SdkLauncher implements AgentLauncher {
  private readonly config: Required<Pick<SdkLauncherConfig, "defaultProvider" | "launchTimeout">> & SdkLauncherConfig;
  private readonly router = new AgentInvocationRouter();
  private readonly activeTasks = new Map<string, Promise<void>>();

  constructor(config: SdkLauncherConfig = {}) {
    this.config = {
      defaultProvider: config.defaultProvider ?? "codex",
      launchTimeout: config.launchTimeout ?? 60_000,
      ...config,
    };
  }

  async launch(prompt: string, cwd: string, executionId?: string): Promise<LaunchResult> {
    try {
      const launchConfig = this.resolveLaunchConfig(cwd);
      const handle = await this.invokeWithTimeout({
        provider: launchConfig.provider,
        taskKind: "prd",
        cwd,
        prompt,
        metadata: this.buildMetadata(executionId, launchConfig),
      });

      const consumePromise = this.consumeHandle(handle, executionId);
      this.activeTasks.set(handle.taskId, consumePromise);
      void consumePromise.finally(() => {
        this.activeTasks.delete(handle.taskId);
      });

      this.log(
        "info",
        `Launched ${launchConfig.provider} SDK task ${handle.taskId} in ${cwd}`
      );

      return {
        success: true,
        agentTaskId: handle.taskId,
        logPath: handle.logPath ?? null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log("error", `Failed to launch SDK task: ${message}`);
      return {
        success: false,
        error: message,
      };
    }
  }

  private resolveLaunchConfig(cwd: string): {
    provider: Provider;
    codex: {
      approvalPolicy?: CodexApprovalPolicy;
      sandboxMode?: CodexSandboxMode;
      level?: CodexLevel;
    };
  } {
    const agentConfig = getConfig(cwd).agent;

    return {
      provider: agentConfig.provider ?? this.config.defaultProvider,
      codex: {
        approvalPolicy: this.config.codex?.approvalPolicy ?? agentConfig.codex?.approvalPolicy,
        sandboxMode: this.config.codex?.sandboxMode ?? agentConfig.codex?.sandboxMode,
        level: this.config.codex?.level ?? agentConfig.codex?.level,
      },
    };
  }

  private async invokeWithTimeout(req: {
    provider: Provider;
    taskKind: "prd";
    cwd: string;
    prompt: string;
    metadata?: Record<string, unknown>;
  }): Promise<AgentHandle> {
    if (this.config.launchTimeout <= 0) {
      return this.router.invoke(req);
    }

    let timeoutHandle: NodeJS.Timeout | null = null;

    try {
      return await Promise.race([
        this.router.invoke(req),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`SDK launch timeout after ${this.config.launchTimeout}ms`));
          }, this.config.launchTimeout);
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private buildMetadata(
    executionId: string | undefined,
    launchConfig: ReturnType<SdkLauncher["resolveLaunchConfig"]>
  ): Record<string, unknown> | undefined {
    const metadata: Record<string, unknown> = {};

    if (executionId) {
      metadata.executionId = executionId;
    }

    if (launchConfig.provider === "codex") {
      metadata.codex = {
        approvalPolicy: launchConfig.codex.approvalPolicy,
        sandboxMode: launchConfig.codex.sandboxMode,
        level: launchConfig.codex.level,
      };
    }

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  private async consumeHandle(handle: AgentHandle, executionId?: string): Promise<void> {
    try {
      for await (const event of handle.events) {
        if (event.phase === "failed") {
          this.log(
            "warn",
            `${handle.taskId} reported failure${event.message ? `: ${event.message}` : ""}`
          );
        }
      }

      const result = await handle.wait();
      await this.handleCompletion(handle.taskId, executionId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log("error", `SDK task ${handle.taskId} stream error: ${message}`);
      await this.markExecutionFailed(executionId, message, "failed");
    }
  }

  private async handleCompletion(
    taskId: string,
    executionId: string | undefined,
    result: AgentResult
  ): Promise<void> {
    if (result.status === "success") {
      this.log("info", `SDK task ${taskId} completed successfully`);
      return;
    }

    const status = result.status === "cancelled" ? "interrupted" : "failed";
    const message = result.error || `SDK task ended with status ${result.status}`;
    this.log(
      status === "failed" ? "error" : "warn",
      `SDK task ${taskId} ended with status ${result.status}: ${message}`
    );
    await this.markExecutionFailed(executionId, message, status);
  }

  private async markExecutionFailed(
    executionId: string | undefined,
    error: string,
    status: "failed" | "interrupted"
  ): Promise<void> {
    if (!executionId) {
      return;
    }

    const execution = (await listExecutions()).find((item) => item.id === executionId);
    if (!execution || !["starting", "running"].includes(execution.status)) {
      return;
    }

    await updateExecution(
      executionId,
      {
        status,
        lastError: error,
        updatedAt: new Date(),
      },
      { skipTransitionValidation: true }
    );
  }

  private log(level: LogLevel, message: string): void {
    if (this.config.onLog) {
      this.config.onLog(level, message);
      return;
    }

    const prefix = level === "error" ? "ERROR" : level === "warn" ? "WARN" : "INFO";
    console.log(`[SDK Launcher ${prefix}] ${message}`);
  }
}

export function createSdkLauncher(config: SdkLauncherConfig = {}): AgentLauncher {
  return new SdkLauncher(config);
}
