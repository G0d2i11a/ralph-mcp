// Claude SDK Backend
// Based on verified API from @anthropic-ai/claude-agent-sdk
import type {
  AgentBackend,
  AgentRequest,
  AgentHandle,
  AgentEvent,
  AgentResult,
} from "../types.js";
import { writeFileSync, appendFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { resolveAgentLogPath } from "../log-path.js";

type UsageLike = {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
};

interface QueryState {
  controller: AbortController;
  waitPromise: Promise<AgentResult> | null;
  completion: {
    resolve: (result: AgentResult) => void;
    reject: (error: unknown) => void;
  };
  finalResult: AgentResult | null;
  sessionId: string | null;
}

export class ClaudeSdkBackend implements AgentBackend {
  name = "claude-sdk";
  private tasks = new Map<string, QueryState>();
  private taskSeq = 0;
  private queryFn: any = null;

  private async importClaudeSdk(): Promise<any> {
    try {
      const moduleName = "@anthropic-ai/claude-agent-sdk";
      return await import(moduleName);
    } catch {
      const backendDir = dirname(fileURLToPath(import.meta.url));
      const repoRoot = resolve(backendDir, "..", "..", "..");
      const fallbackPath = join(
        repoRoot,
        "..",
        "agent-browser",
        "node_modules",
        "@anthropic-ai",
        "claude-agent-sdk",
        "sdk.mjs"
      );

      return await import(pathToFileURL(fallbackPath).href);
    }
  }

  async healthcheck(): Promise<{ healthy: boolean; message?: string }> {
    try {
      // Check if running inside Claude Code session
      if (process.env.CLAUDECODE) {
        return {
          healthy: false,
          message: "Cannot run inside Claude Code session (CLAUDECODE env var is set). The SDK requires spawning 'claude' CLI as subprocess, which is blocked in nested sessions.",
        };
      }

      if (!this.queryFn) {
        const sdk = await this.importClaudeSdk();
        this.queryFn = sdk.query;
      }
      if (typeof this.queryFn !== "function") {
        return {
          healthy: false,
          message: "query function not available from @anthropic-ai/claude-agent-sdk",
        };
      }
      return { healthy: true };
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async start(req: AgentRequest): Promise<AgentHandle> {
    // Lazy load SDK
    if (!this.queryFn) {
      const health = await this.healthcheck();
      if (!health.healthy) {
        throw new Error(`Claude SDK not available: ${health.message}`);
      }
    }

    const startTime = Date.now();
    const localTaskId = this.makeTaskId();
    const logPath = resolveAgentLogPath(localTaskId, req.metadata);
    writeFileSync(logPath, "");

    const controller = new AbortController();

    let resolveCompletion!: (result: AgentResult) => void;
    let rejectCompletion!: (error: unknown) => void;
    const waitPromise = new Promise<AgentResult>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const state: QueryState = {
      controller,
      waitPromise,
      completion: {
        resolve: resolveCompletion,
        reject: rejectCompletion,
      },
      finalResult: null,
      sessionId: null,
    };

    this.tasks.set(localTaskId, state);

    const logEvent = (event: AgentEvent) => {
      appendFileSync(logPath, JSON.stringify(event) + "\n");
    };

    const events = this.streamEvents(
      localTaskId,
      req,
      startTime,
      controller.signal,
      logEvent
    );

    return {
      taskId: localTaskId,
      logPath,
      events,
      wait: () => waitPromise,
    };
  }

  private async *streamEvents(
    taskId: string,
    req: AgentRequest,
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
      provider: "claude",
      phase: "starting",
      at: new Date().toISOString(),
    };
    logEvent(startEvent);
    yield startEvent;

    let finalResponse = "";
    let finalUsage: UsageLike | null = null;
    let errorMessage: string | null = null;

    try {
      // Check if running inside Claude Code session
      if (process.env.CLAUDECODE) {
        throw new Error(
          "Cannot invoke Claude SDK from within a Claude Code session. " +
          "The SDK spawns the 'claude' CLI as a subprocess, which is blocked when CLAUDECODE env var is set. " +
          "To use this backend, run from outside Claude Code or unset CLAUDECODE environment variable."
        );
      }

      const queryInstance = this.queryFn({
        prompt: req.prompt,
        options: {
          cwd: req.cwd,
          model: req.model || "claude-opus-4-6",
          maxTurns: 50,
          permissionMode: "bypassPermissions",
          persistSession: false,
          settingSources: [],
          includePartialMessages: false,
          abortController: state.controller,
        },
      });

      for await (const message of queryInstance) {
        if (signal.aborted) {
          throw new Error("Task cancelled");
        }

        const agentEvent: AgentEvent = {
          taskId,
          provider: "claude",
          phase: "running",
          at: new Date().toISOString(),
          raw: message,
        };

        if (message && typeof message === "object" && "session_id" in message) {
          state.sessionId = String(message.session_id);
        }

        if (message && typeof message === "object" && "type" in message) {
          const msgType = String(message.type);
          agentEvent.step = msgType;

          if (msgType === "system" && "subtype" in message) {
            const subtype = String(message.subtype);
            agentEvent.message = `${msgType}.${subtype}`;

            if (subtype === "init" && "model" in message) {
              agentEvent.message = `init:${message.model}`;
            }
          } else if (msgType === "assistant" && "message" in message) {
            const msg = message.message as any;
            if (msg && Array.isArray(msg.content)) {
              for (const block of msg.content) {
                if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
                  finalResponse = block.text;
                  agentEvent.message = block.text.slice(0, 200);
                }
              }
            }
            if (msg && typeof msg.usage === "object" && msg.usage) {
              finalUsage = msg.usage;
            }
          } else if (msgType === "result") {
            agentEvent.phase = "completed";
            if ("subtype" in message) {
              const subtype = String(message.subtype);
              agentEvent.message = `result.${subtype}`;

              if (subtype === "error" && "errors" in message && Array.isArray(message.errors)) {
                errorMessage = message.errors.map((e: any) => String(e)).join("; ");
                agentEvent.phase = "failed";
              }
            }
          } else {
            agentEvent.message = msgType;
          }
        }

        logEvent(agentEvent);
        yield agentEvent;

        if (message && typeof message === "object" && "type" in message && message.type === "result") {
          break;
        }
      }

      const result: AgentResult = {
        taskId,
        provider: "claude",
        status: errorMessage ? "error" : (signal.aborted ? "cancelled" : "success"),
        output: finalResponse || undefined,
        error: errorMessage || undefined,
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
        sessionId: state.sessionId || undefined,
      };

      state.finalResult = result;
      state.completion.resolve(result);

      if (!signal.aborted) {
        const completeEvent: AgentEvent = {
          taskId,
          provider: "claude",
          phase: result.status === "error" ? "failed" : "completed",
          at: new Date().toISOString(),
          message: result.error || (finalResponse ? finalResponse.slice(0, 200) : "completed"),
        };
        logEvent(completeEvent);
        yield completeEvent;
      }
    } catch (error) {
      if (signal.aborted) {
        const cancelledResult: AgentResult = {
          taskId,
          provider: "claude",
          status: "cancelled",
          duration: Date.now() - startTime,
          sessionId: state.sessionId || undefined,
        };
        state.finalResult = cancelledResult;
        state.completion.resolve(cancelledResult);

        const cancelEvent: AgentEvent = {
          taskId,
          provider: "claude",
          phase: "cancelled",
          message: "Task cancelled by user",
          at: new Date().toISOString(),
        };
        logEvent(cancelEvent);
        yield cancelEvent;
      } else {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const errorResult: AgentResult = {
          taskId,
          provider: "claude",
          status: "error",
          error: errorMsg,
          duration: Date.now() - startTime,
          sessionId: state.sessionId || undefined,
        };
        state.finalResult = errorResult;
        state.completion.resolve(errorResult);

        const errorEvent: AgentEvent = {
          taskId,
          provider: "claude",
          phase: "failed",
          message: errorMsg,
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
    return `claude-${Date.now()}-${this.taskSeq}`;
  }
}
