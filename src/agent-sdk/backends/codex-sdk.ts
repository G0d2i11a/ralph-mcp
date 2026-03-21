// Codex SDK Backend
// Based on verified source code from openai/codex repository (sdk/typescript/)
import type {
  AgentBackend,
  AgentRequest,
  AgentHandle,
  AgentEvent,
  AgentResult,
} from "../types.js";
import { existsSync, writeFileSync, appendFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { resolveAgentLogPath } from "../log-path.js";

type CodexApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";
type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type CodexLevel = "L1" | "L2" | "L3" | "L4";

const OPENCLAW_ROOT = "/Users/shawn/Workspace/openclaw";

type UsageLike = {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
};

interface ThreadState {
  thread: any;
  controller: AbortController;
  waitPromise: Promise<AgentResult> | null;
  completion: {
    resolve: (result: AgentResult) => void;
    reject: (error: unknown) => void;
  };
  finalResult: AgentResult | null;
  realThreadId: string | null;
}

interface CodexRequestMetadata {
  executionId?: string;
  codex?: {
    approvalPolicy?: CodexApprovalPolicy;
    sandboxMode?: CodexSandboxMode;
    level?: CodexLevel;
  };
}

export class CodexSdkBackend implements AgentBackend {
  name = "codex-sdk";
  private codex: any = null;
  private tasks = new Map<string, ThreadState>();
  private taskSeq = 0;

  async healthcheck(): Promise<{ healthy: boolean; message?: string }> {
    try {
      if (!this.codex) {
        let sdk: any;
        try {
          sdk = await this.importCodexSdk();
        } catch (importError) {
          return {
            healthy: false,
            message: "Codex SDK not installed: @openai/codex-sdk package not found",
          };
        }
        this.codex = new sdk.Codex({
          baseUrl: process.env.OPENAI_BASE_URL || "http://localhost:4000/v1",
          apiKey: process.env.OPENAI_API_KEY,
        });
      }
      return { healthy: true };
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async importCodexSdk(): Promise<any> {
    try {
      const moduleName = "@openai/codex-sdk";
      return await import(moduleName);
    } catch {
      const backendDir = dirname(fileURLToPath(import.meta.url));
      const repoRoot = resolve(backendDir, "..", "..", "..");
      const fallbackRoots = [OPENCLAW_ROOT, resolve(repoRoot, "..")];
      const fallbackPaths = [
        ...fallbackRoots.map((root) =>
          join(root, "agent-runners", "node_modules", "@openai", "codex-sdk", "dist", "index.js")
        ),
        ...fallbackRoots.map((root) =>
          join(root, "sdk-runners", "node_modules", "@openai", "codex-sdk", "dist", "index.js")
        ),
      ];

      for (const fallbackPath of new Set(fallbackPaths)) {
        if (!existsSync(fallbackPath)) {
          continue;
        }

        try {
          return await import(pathToFileURL(fallbackPath).href);
        } catch {
          continue;
        }
      }

      throw new Error("@openai/codex-sdk package not found");
    }
  }

  async start(req: AgentRequest): Promise<AgentHandle> {
    // Lazy load SDK
    if (!this.codex) {
      const health = await this.healthcheck();
      if (!health.healthy) {
        throw new Error(`Codex SDK not available: ${health.message}`);
      }
    }

    const startTime = Date.now();
    const localTaskId = this.makeTaskId();
    const logPath = resolveAgentLogPath(localTaskId, req.metadata);
    writeFileSync(logPath, "");
    const { approvalPolicy, sandboxMode, level } = this.getCodexOptions(req.metadata);

    const thread = this.codex.startThread({
      workingDirectory: req.cwd,
      model: req.model || "gpt-5.4",
      approvalPolicy,
      sandboxMode,
      modelReasoningEffort: this.mapLevelToReasoningEffort(level),
    });

    let resolveCompletion!: (result: AgentResult) => void;
    let rejectCompletion!: (error: unknown) => void;
    const waitPromise = new Promise<AgentResult>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const state: ThreadState = {
      thread,
      controller: new AbortController(),
      waitPromise,
      completion: {
        resolve: resolveCompletion,
        reject: rejectCompletion,
      },
      finalResult: null,
      realThreadId: null,
    };

    this.tasks.set(localTaskId, state);

    const logEvent = (event: AgentEvent) => {
      appendFileSync(logPath, JSON.stringify(event) + "\n");
    };

    const events = this.streamEvents(
      localTaskId,
      req.prompt,
      startTime,
      state.controller.signal,
      logEvent
    );

    return {
      taskId: localTaskId,
      logPath,
      events,
      wait: () => waitPromise,
    };
  }

  private getCodexOptions(metadata?: Record<string, unknown>): {
    approvalPolicy: CodexApprovalPolicy;
    sandboxMode: CodexSandboxMode;
    level: CodexLevel;
  } {
    const codex = (metadata as CodexRequestMetadata | undefined)?.codex;

    return {
      approvalPolicy: codex?.approvalPolicy ?? "on-request",
      sandboxMode: codex?.sandboxMode ?? "workspace-write",
      level: codex?.level ?? "L2",
    };
  }

  private mapLevelToReasoningEffort(level: CodexLevel): "low" | "medium" | "high" | "xhigh" {
    switch (level) {
      case "L1":
        return "low";
      case "L2":
        return "medium";
      case "L3":
        return "high";
      case "L4":
        return "xhigh";
    }
  }

  private async *streamEvents(
    taskId: string,
    prompt: string,
    startTime: number,
    signal: AbortSignal,
    logEvent: (event: AgentEvent) => void
  ): AsyncIterable<AgentEvent> {
    const state = this.tasks.get(taskId);
    if (!state) {
      throw new Error(`Task ${taskId} not found`);
    }

    const startEvent: AgentEvent = {
      taskId,
      provider: "codex",
      phase: "starting",
      at: new Date().toISOString(),
    };
    logEvent(startEvent);
    yield startEvent;

    let finalResponse = "";
    let finalUsage: UsageLike | null = null;

    try {
      const { events } = await state.thread.runStreamed(prompt, { signal });

      for await (const event of events) {
        if (signal.aborted) {
          throw new Error("Task cancelled");
        }

        const agentEvent: AgentEvent = {
          taskId,
          provider: "codex",
          phase: "running",
          at: new Date().toISOString(),
          raw: event,
        };

        switch (event.type) {
          case "thread.started":
            state.realThreadId = event.thread_id;
            agentEvent.message = `thread.started:${event.thread_id}`;
            break;
          case "turn.started":
            agentEvent.message = "turn.started";
            break;
          case "item.started":
          case "item.updated":
          case "item.completed": {
            const itemType = event.item?.type;
            agentEvent.step = itemType;
            agentEvent.message = itemType || event.type;

            if (itemType === "agent_message" && typeof event.item?.text === "string") {
              finalResponse = event.item.text;
            } else if (
              itemType === "reasoning" &&
              typeof event.item?.text === "string"
            ) {
              agentEvent.message = event.item.text.slice(0, 200);
            } else if (
              itemType === "command_execution" &&
              typeof event.item?.command === "string"
            ) {
              agentEvent.message = event.item.command;
            } else if (
              itemType === "web_search" &&
              typeof event.item?.query === "string"
            ) {
              agentEvent.message = event.item.query;
            }
            break;
          }
          case "turn.completed":
            finalUsage = event.usage || null;
            agentEvent.phase = "completed";
            agentEvent.message = "turn.completed";
            break;
          case "turn.failed":
            agentEvent.phase = "failed";
            agentEvent.message = event.error?.message || "Task failed";
            break;
          case "error":
            agentEvent.phase = "failed";
            agentEvent.message = event.message || "Stream error";
            break;
          default:
            agentEvent.message = (event as { type?: string }).type || "unknown";
            break;
        }

        logEvent(agentEvent);
        yield agentEvent;
      }

      const result: AgentResult = {
        taskId,
        provider: "codex",
        status: signal.aborted ? "cancelled" : "success",
        output: finalResponse || undefined,
        usage: finalUsage
          ? {
              promptTokens: finalUsage.input_tokens || 0,
              completionTokens: finalUsage.output_tokens || 0,
              totalTokens:
                (finalUsage.input_tokens || 0) +
                (finalUsage.output_tokens || 0) +
                (finalUsage.cached_input_tokens || 0),
            }
          : undefined,
        duration: Date.now() - startTime,
      };

      state.finalResult = result;
      state.completion.resolve(result);

      if (!signal.aborted) {
        const completeEvent: AgentEvent = {
          taskId,
          provider: "codex",
          phase: "completed",
          at: new Date().toISOString(),
          message: finalResponse ? finalResponse.slice(0, 200) : "completed",
        };
        logEvent(completeEvent);
        yield completeEvent;
      }
    } catch (error) {
      if (signal.aborted) {
        const cancelledResult: AgentResult = {
          taskId,
          provider: "codex",
          status: "cancelled",
          duration: Date.now() - startTime,
        };
        state.finalResult = cancelledResult;
        state.completion.resolve(cancelledResult);

        const cancelEvent: AgentEvent = {
          taskId,
          provider: "codex",
          phase: "cancelled",
          message: "Task cancelled by user",
          at: new Date().toISOString(),
        };
        logEvent(cancelEvent);
        yield cancelEvent;
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorResult: AgentResult = {
          taskId,
          provider: "codex",
          status: "error",
          error: errorMessage,
          duration: Date.now() - startTime,
        };
        state.finalResult = errorResult;
        state.completion.resolve(errorResult);

        const errorEvent: AgentEvent = {
          taskId,
          provider: "codex",
          phase: "failed",
          message: errorMessage,
          at: new Date().toISOString(),
        };
        logEvent(errorEvent);
        yield errorEvent;
      }
    } finally {
      this.tasks.delete(taskId);
    }
  }

  async cancel(taskId: string): Promise<void> {
    const state = this.tasks.get(taskId);
    if (!state) {
      throw new Error(`Task ${taskId} not found`);
    }

    state.controller.abort();

    if (state.waitPromise) {
      try {
        await state.waitPromise;
      } catch {
        // ignore
      }
    }
  }

  private makeTaskId(): string {
    this.taskSeq += 1;
    return `codex-${Date.now()}-${this.taskSeq}`;
  }
}
