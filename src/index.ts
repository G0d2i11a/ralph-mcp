#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync, unlinkSync } from "fs";
import { homedir } from "os";
import { randomUUID } from "crypto";

import { isRunnerAlive } from "./utils/runner-singleton.js";
import { registerMcpClient, heartbeatMcpClient, unregisterMcpClient } from "./store/state.js";

import { start, startInputSchema } from "./tools/start.js";
import { batchStart, batchStartInputSchema } from "./tools/batch-start.js";
import { status, statusInputSchema } from "./tools/status.js";
import { get, getInputSchema } from "./tools/get.js";
import { update, updateInputSchema } from "./tools/update.js";
import { stop, stopInputSchema } from "./tools/stop.js";
import { merge, mergeInputSchema, mergeQueueAction, mergeQueueInputSchema } from "./tools/merge.js";
import { setAgentId, setAgentIdInputSchema } from "./tools/set-agent-id.js";
import { resetStagnationTool, resetStagnationInputSchema } from "./tools/reset-stagnation.js";
import { retry, retryInputSchema } from "./tools/retry.js";
import { doctor, doctorInputSchema } from "./tools/doctor.js";
import { claimReady, claimReadyInputSchema } from "./tools/claim-ready.js";
import { setConcurrency, setConcurrencyInputSchema } from "./tools/set-concurrency.js";
import { shutdown, shutdownInputSchema, setShutdownCallback } from "./tools/shutdown.js";

const server = new Server(
  {
    name: "ralph",
    version: "1.1.4",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "ralph_start",
        description:
          "Start PRD execution. Parses PRD file, creates worktree, and stores ready/pending state for the Runner. Manual agent prompts are returned only when RALPH_AUTO_RUNNER=false. Dependencies must be merged before dependents start unless ignored.",
        annotations: {
          title: "Start PRD Execution",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            prdPath: {
              type: "string",
              description: "Path to the PRD markdown file (e.g., tasks/prd-xxx.md)",
            },
            projectRoot: {
              type: "string",
              description: "Project root directory (defaults to cwd)",
            },
            worktree: {
              type: "boolean",
              description: "Create a worktree for isolation (default: true)",
              default: true,
            },
            autoStart: {
              type: "boolean",
              description: "Generate agent prompt for auto-start (default: true)",
              default: true,
            },
            autoMerge: {
              type: "boolean",
              description: "Auto add to merge queue when all stories pass (default: true)",
              default: true,
            },
            notifyOnComplete: {
              type: "boolean",
              description: "Show Windows notification when all stories complete (default: true)",
              default: true,
            },
            onConflict: {
              type: "string",
              enum: ["auto_theirs", "auto_ours", "notify", "agent"],
              description: "Conflict resolution strategy for merge (default: agent)",
              default: "agent",
            },
            contextInjectionPath: {
              type: "string",
              description: "Path to a file (e.g., CLAUDE.md) to inject into manual-mode agent prompts",
            },
            ignoreDependencies: {
              type: "boolean",
              description: "Skip dependency check and start even if dependencies are not merged (default: false)",
              default: false,
            },
            queueIfBlocked: {
              type: "boolean",
              description:
                "If dependencies are not satisfied, create a pending execution instead of failing (default: false)",
              default: false,
            },
          },
          required: ["prdPath"],
        },
      },
      {
        name: "ralph_status",
        description:
          "View all PRD execution status. Replaces manual TaskOutput queries. Shows progress, status, and summary.",
        annotations: {
          title: "View Execution Status",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            project: {
              type: "string",
              description: "Filter by project name",
            },
            status: {
              type: "string",
              enum: ["pending", "ready", "starting", "running", "interrupted", "completed", "failed", "stopped", "merging", "merged"],
              description: "Filter by status",
            },
            reconcile: {
              type: "boolean",
              description: "Auto-fix status inconsistencies with git (default: true)",
              default: true,
            },
            historyLimit: {
              type: "number",
              description: "Number of recent archived records to include in history (default: 10)",
              default: 10,
            },
          },
        },
      },
      {
        name: "ralph_get",
        description: "Get detailed status of a single PRD execution including all user stories.",
        annotations: {
          title: "Get Execution Details",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            branch: {
              type: "string",
              description: "Branch name (e.g., ralph/task1-agent)",
            },
          },
          required: ["branch"],
        },
      },
      {
        name: "ralph_update",
        description:
          "Update User Story status. Called by subagent after completing a story.",
        annotations: {
          title: "Update Story Status",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            branch: {
              type: "string",
              description: "Branch name (e.g., ralph/task1-agent)",
            },
            storyId: {
              type: "string",
              description: "Story ID (e.g., US-001)",
            },
            passes: {
              type: "boolean",
              description: "Whether the story passes",
            },
            notes: {
              type: "string",
              description: "Implementation notes",
            },
            filesChanged: {
              type: "number",
              description: "Number of files changed (for stagnation detection)",
            },
            error: {
              type: "string",
              description: "Error message if stuck (for stagnation detection)",
            },
            step: {
              type: "string",
              description: "Current step label (e.g., implementing/testing/building/verifying)",
            },
            acEvidence: {
              type: "object",
              description: "Per-AC evidence mapping, keyed by AC id",
              additionalProperties: {
                type: "object",
                properties: {
                  passes: { type: "boolean" },
                  evidence: { type: "string" },
                  command: { type: "string" },
                  output: { type: "string" },
                  blockedReason: { type: "string" },
                },
              },
            },
            hardGates: {
              type: "object",
              description: "Hard gate verification results for typecheck/build",
            },
            skipHardGates: {
              type: "boolean",
              description: "Skip hard gate verification for non-code stories (default: false)",
              default: false,
            },
            scopeExplanation: {
              type: "object",
              description: "Required explanation when scope guardrails are exceeded",
            },
            skipScopeCheck: {
              type: "boolean",
              description: "Skip scope guardrail check (default: false)",
              default: false,
            },
            expectedFiles: {
              type: "array",
              items: { type: "string" },
              description: "Files declared before implementation that are expected to change",
            },
            unexpectedFileExplanation: {
              type: "object",
              description: "Explanation for files changed outside expectedFiles declaration",
            },
          },
          required: ["branch", "storyId", "passes"],
        },
      },
      {
        name: "ralph_stop",
        description: "Stop PRD execution. Optionally clean up worktree.",
        annotations: {
          title: "Stop Execution",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            branch: {
              type: "string",
              description: "Branch name to stop",
            },
            cleanup: {
              type: "boolean",
              description: "Also remove the worktree (default: false)",
              default: false,
            },
            deleteRecord: {
              type: "boolean",
              description: "Delete the execution record from database (default: false)",
              default: false,
            },
          },
          required: ["branch"],
        },
      },
      {
        name: "ralph_merge",
        description:
          "Merge completed PRD to main and clean up worktree. MCP executes directly without Claude context.",
        annotations: {
          title: "Merge to Main",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            branch: {
              type: "string",
              description: "Branch name to merge",
            },
            force: {
              type: "boolean",
              description: "Skip verification checks (default: false)",
              default: false,
            },
            onConflict: {
              type: "string",
              enum: ["auto_theirs", "auto_ours", "notify", "agent"],
              description: "Override conflict resolution strategy",
            },
            skipQualityChecks: {
              type: "boolean",
              description: "Skip type check and build (default: false)",
              default: false,
            },
          },
          required: ["branch"],
        },
      },
      {
        name: "ralph_merge_queue",
        description:
          "Manage merge queue. Default serial merge to avoid conflicts.",
        annotations: {
          title: "Manage Merge Queue",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["list", "add", "remove", "process"],
              description: "Queue action (default: list)",
              default: "list",
            },
            branch: {
              type: "string",
              description: "Branch for add/remove actions",
            },
          },
        },
      },
      {
        name: "ralph_set_agent_id",
        description:
          "Record the Claude Task agent ID for an execution. Called after starting a Task agent.",
        annotations: {
          title: "Set Agent ID",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            branch: {
              type: "string",
              description: "Branch name",
            },
            agentTaskId: {
              type: "string",
              description: "Claude Task agent ID",
            },
          },
          required: ["branch", "agentTaskId"],
        },
      },
      {
        name: "ralph_batch_start",
        description:
          "Start multiple PRDs with dependency resolution. Parses all PRDs, creates worktrees, preheats dependencies, and queues ready/pending executions for the Runner. Manual prompts are returned only when RALPH_AUTO_RUNNER=false.",
        annotations: {
          title: "Batch Start PRDs",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            prdPaths: {
              type: "array",
              items: { type: "string" },
              description: "Array of paths to PRD markdown files",
            },
            projectRoot: {
              type: "string",
              description: "Project root directory (defaults to cwd)",
            },
            worktree: {
              type: "boolean",
              description: "Create worktrees for isolation (default: true)",
              default: true,
            },
            autoMerge: {
              type: "boolean",
              description: "Auto add to merge queue when all stories pass (default: true)",
              default: true,
            },
            notifyOnComplete: {
              type: "boolean",
              description: "Show Windows notification when all stories complete (default: true)",
              default: true,
            },
            onConflict: {
              type: "string",
              enum: ["auto_theirs", "auto_ours", "notify", "agent"],
              description: "Conflict resolution strategy for merge (default: agent)",
              default: "agent",
            },
            contextInjectionPath: {
              type: "string",
              description: "Path to a file (e.g., CLAUDE.md) to inject into the agent prompt",
            },
            preheat: {
              type: "boolean",
              description: "Run pnpm install serially before starting agents (default: true)",
              default: true,
            },
          },
          required: ["prdPaths"],
        },
      },
      {
        name: "ralph_reset_stagnation",
        description:
          "Reset stagnation counters for an execution. Use after manual intervention to allow the agent to continue.",
        annotations: {
          title: "Reset Stagnation",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            branch: {
              type: "string",
              description: "Branch name (e.g., ralph/task1-agent)",
            },
            resumeExecution: {
              type: "boolean",
              description: "Also set status back to 'running' if currently 'failed' (default: true)",
              default: true,
            },
          },
          required: ["branch"],
        },
      },
      {
        name: "ralph_retry",
        description:
          "Retry a failed/interrupted PRD execution. Resets stagnation counters, handles uncommitted changes (WIP), and generates a new agent prompt to continue from where it left off.",
        annotations: {
          title: "Retry Execution",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            branch: {
              type: "string",
              description: "Branch name (e.g., ralph/task1-agent)",
            },
            wipPolicy: {
              type: "string",
              enum: ["stash", "commit", "keep"],
              description: "How to handle uncommitted changes: stash (default), commit, or keep",
              default: "stash",
            },
          },
          required: ["branch"],
        },
      },
      {
        name: "ralph_doctor",
        description:
          "Run environment diagnostics. Checks git, node, pnpm, worktree support, and permissions. Run before ralph_start to catch issues early.",
        annotations: {
          title: "Environment Diagnostics",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            projectRoot: {
              type: "string",
              description: "Project root directory to check (defaults to cwd)",
            },
            verbose: {
              type: "boolean",
              description: "Include detailed version info and paths (default: false)",
              default: false,
            },
          },
        },
      },
      {
        name: "ralph_claim_ready",
        description:
          "Atomically claim a ready PRD for execution. Used by Ralph Runner to safely pick up PRDs without race conditions. Returns agent prompt if successful.",
        annotations: {
          title: "Claim Ready PRD",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            branch: {
              type: "string",
              description: "Branch name of the PRD to claim (e.g., ralph/task1-agent)",
            },
          },
          required: ["branch"],
        },
      },
      {
        name: "ralph_set_concurrency",
        description:
          "Set maximum concurrent PRD executions at runtime. The Runner will apply the change on its next poll cycle.",
        annotations: {
          title: "Set Concurrency",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            maxConcurrent: {
              type: "number",
              description: "Maximum concurrent PRD executions (1-10)",
              minimum: 1,
              maximum: 10,
            },
            reason: {
              type: "string",
              description: "Optional reason for changing concurrency",
            },
          },
          required: ["maxConcurrent"],
        },
      },
      {
        name: "ralph_shutdown",
        description:
          "Shutdown the Ralph MCP Server and Runner. Use this to manually stop the MCP when you want to restart it with new code.",
        annotations: {
          title: "Shutdown MCP",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "Optional reason for shutdown",
            },
            force: {
              type: "boolean",
              description: "Force shutdown even if PRDs are running (default: false)",
              default: false,
            },
          },
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: unknown;

    switch (name) {
      case "ralph_start":
        result = await start(startInputSchema.parse(args));
        break;
      case "ralph_status":
        result = await status(statusInputSchema.parse(args || {}));
        break;
      case "ralph_get":
        result = await get(getInputSchema.parse(args));
        break;
      case "ralph_update":
        result = await update(updateInputSchema.parse(args));
        break;
      case "ralph_stop":
        result = await stop(stopInputSchema.parse(args));
        break;
      case "ralph_merge":
        result = await merge(mergeInputSchema.parse(args));
        break;
      case "ralph_merge_queue":
        result = await mergeQueueAction(mergeQueueInputSchema.parse(args || {}));
        break;
      case "ralph_set_agent_id":
        result = await setAgentId(setAgentIdInputSchema.parse(args));
        break;
      case "ralph_batch_start":
        result = await batchStart(batchStartInputSchema.parse(args));
        break;
      case "ralph_reset_stagnation":
        result = await resetStagnationTool(resetStagnationInputSchema.parse(args));
        break;
      case "ralph_retry":
        result = await retry(retryInputSchema.parse(args));
        break;
      case "ralph_doctor":
        result = await doctor(doctorInputSchema.parse(args || {}));
        break;
      case "ralph_claim_ready":
        result = await claimReady(claimReadyInputSchema.parse(args));
        break;
      case "ralph_set_concurrency":
        result = await setConcurrency(setConcurrencyInputSchema.parse(args));
        break;
      case "ralph_shutdown":
        result = await shutdown(shutdownInputSchema.parse(args || {}));
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: message }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// Start server
const mcpClientId = randomUUID();
let clientHeartbeatTimer: NodeJS.Timeout | null = null;

async function startRunner(): Promise<void> {
  // Check if RALPH_AUTO_RUNNER is explicitly disabled
  if (process.env.RALPH_AUTO_RUNNER === "false") {
    console.error("Ralph Runner auto-start disabled (RALPH_AUTO_RUNNER=false)");
    return;
  }

  // 1. Register this MCP client
  await registerMcpClient(mcpClientId, process.pid);

  // 2. Start heartbeat timer (every 10s)
  clientHeartbeatTimer = setInterval(() => {
    heartbeatMcpClient(mcpClientId).catch(() => {});
  }, 10_000);
  clientHeartbeatTimer.unref();

  // 3. Check if Runner is already alive
  if (await isRunnerAlive()) {
    console.error("Ralph Runner already running (singleton detected), skipping spawn");
    return;
  }

  // 4. Spawn Runner as detached process
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const runnerPath = join(__dirname, "runner-cli.js");

  try {
    const child = spawn("node", [runnerPath], {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, RALPH_RUNNER_SPAWNED: "true" },
    });
    child.unref();
    console.error("Ralph Runner spawned as detached process");
  } catch (err) {
    console.error("Failed to spawn Ralph Runner:", err);
  }
}

async function stopRunner(): Promise<void> {
  // 1. Clear heartbeat timer
  if (clientHeartbeatTimer) {
    clearInterval(clientHeartbeatTimer);
    clientHeartbeatTimer = null;
  }

  // 2. Unregister this MCP client (Runner manages its own lifecycle)
  try {
    await unregisterMcpClient(mcpClientId);
  } catch {
    // Ignore - best effort
  }

  console.error("MCP client unregistered; Runner will self-exit when idle");
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Ralph MCP Server started");

  // Auto-start Runner
  await startRunner();

  // Set shutdown callback for the shutdown tool
  setShutdownCallback((reason) => {
    console.error(`Shutdown requested: ${reason}`);
    stopRunner().finally(() => process.exit(0));
  });

  // Watch for shutdown signal file (from Monitor TUI)
  const dataDir = process.env.RALPH_DATA_DIR?.replace("~", homedir()) || join(homedir(), ".ralph");
  const signalPath = join(dataDir, "shutdown-signal");
  let signalCheckTimer: NodeJS.Timeout | null = null;

  signalCheckTimer = setInterval(() => {
    if (existsSync(signalPath)) {
      try {
        unlinkSync(signalPath);
        console.error("Shutdown signal detected from Monitor TUI");
        stopRunner().finally(() => {
          if (signalCheckTimer) clearInterval(signalCheckTimer);
          process.exit(0);
        });
      } catch {
        // Ignore cleanup errors
      }
    }
  }, 1000);
  signalCheckTimer.unref();

  // Cleanup on exit
  process.on("SIGINT", () => {
    stopRunner().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    stopRunner().finally(() => process.exit(0));
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
