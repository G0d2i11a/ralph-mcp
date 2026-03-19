// Agent Invocation Router with lazy loading
import type { Provider, AgentRequest, AgentHandle, AgentBackend } from "./types.js";

export class AgentInvocationRouter {
  private backends: Map<Provider, AgentBackend | null>;
  private backendFactories: Map<Provider, () => Promise<AgentBackend>>;

  constructor() {
    this.backends = new Map([
      ["codex", null],
      ["claude", null],
    ]);

    this.backendFactories = new Map<Provider, () => Promise<AgentBackend>>([
      ["codex", async () => {
        const { CodexSdkBackend } = await import("./backends/codex-sdk.js");
        return new CodexSdkBackend();
      }],
      ["claude", async () => {
        const { ClaudeSdkBackend } = await import("./backends/claude-sdk.js");
        return new ClaudeSdkBackend();
      }],
    ]);
  }

  private async getBackend(provider: Provider): Promise<AgentBackend> {
    let backend = this.backends.get(provider);
    if (backend) {
      return backend;
    }

    const factory = this.backendFactories.get(provider);
    if (!factory) {
      throw new Error(`Unknown provider: ${provider}`);
    }

    backend = await factory();
    this.backends.set(provider, backend);
    return backend;
  }

  async invoke(req: AgentRequest): Promise<AgentHandle> {
    const backend = await this.getBackend(req.provider);

    if (backend.healthcheck) {
      const health = await backend.healthcheck();
      if (!health.healthy) {
        throw new Error(
          `Backend ${req.provider} is not healthy: ${health.message}`
        );
      }
    }

    return backend.start(req);
  }

  async cancel(provider: Provider, taskId: string): Promise<void> {
    const backend = await this.getBackend(provider);
    return backend.cancel(taskId);
  }

  async healthcheck(provider?: Provider): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};

    if (provider) {
      try {
        const backend = await this.getBackend(provider);
        if (backend.healthcheck) {
          const health = await backend.healthcheck();
          results[provider] = health.healthy;
        }
      } catch {
        results[provider] = false;
      }
    } else {
      for (const [name] of this.backendFactories.entries()) {
        try {
          const backend = await this.getBackend(name);
          if (backend.healthcheck) {
            const health = await backend.healthcheck();
            results[name] = health.healthy;
          }
        } catch {
          results[name] = false;
        }
      }
    }

    return results;
  }
}
