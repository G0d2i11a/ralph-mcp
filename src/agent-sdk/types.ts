// OpenClaw Agent Invocation - Type Definitions
// Unified Agent invocation interface supporting Codex and Claude SDK

export type Provider = "codex" | "claude";
export type TaskKind = "research" | "review" | "code" | "prd" | "general";

export interface AgentRequest {
  provider: Provider;
  taskKind: TaskKind;
  cwd: string;
  prompt: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export type AgentPhase =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export interface AgentEvent {
  taskId: string;
  provider: Provider;
  phase: AgentPhase;
  step?: string;
  percent?: number;
  message?: string;
  at: string;
  raw?: unknown;
}

export interface AgentResult {
  taskId: string;
  provider: Provider;
  status: "success" | "error" | "cancelled";
  output?: string;
  error?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  duration?: number;
  sessionId?: string;
}

export interface AgentHandle {
  taskId: string;
  logPath?: string | null;
  events: AsyncIterable<AgentEvent>;
  wait(): Promise<AgentResult>;
}

export interface AgentBackend {
  name: string;
  start(req: AgentRequest): Promise<AgentHandle>;
  cancel(taskId: string): Promise<void>;
  healthcheck?(): Promise<{ healthy: boolean; message?: string }>;
}
