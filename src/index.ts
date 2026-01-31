#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

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

const server = new Server(
  {
    name: "ralph",
    version: "1.0.0",
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
          "Start PRD execution. Parses PRD file, creates worktree, stores state, and returns agent prompt for auto-start. Fails if dependencies are not satisfied unless ignoreDependencies is true.",
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
            ignoreDependencies: {
              type: "boolean",
              description: "Skip dependency check and start even if dependencies are not satisfied (default: false)",
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
              enum: ["pending", "running", "completed", "failed", "stopped", "merging"],
              description: "Filter by status",
            },
            reconcile: {
              type: "boolean",
              description: "Auto-fix status inconsistencies with git (default: true)",
              default: true,
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
          "Start multiple PRDs with dependency resolution. Parses all PRDs, creates worktrees, runs pnpm install serially (avoids store lock), and returns agent prompts for PRDs whose dependencies are satisfied.",
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
          "Retry a failed PRD execution. Resets stagnation counters and generates a new agent prompt to continue from where it left off.",
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
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Ralph MCP Server started");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
