#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { start, startInputSchema } from "./tools/start.js";
import { status, statusInputSchema } from "./tools/status.js";
import { get, getInputSchema } from "./tools/get.js";
import { update, updateInputSchema } from "./tools/update.js";
import { stop, stopInputSchema } from "./tools/stop.js";
import { merge, mergeInputSchema, mergeQueueAction, mergeQueueInputSchema } from "./tools/merge.js";
import { setAgentId, setAgentIdInputSchema } from "./tools/set-agent-id.js";

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
          "Start PRD execution. Parses PRD file, creates worktree, stores state, and returns agent prompt for auto-start.",
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
              description: "Auto add to merge queue when all stories pass (default: false)",
              default: false,
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
          },
          required: ["prdPath"],
        },
      },
      {
        name: "ralph_status",
        description:
          "View all PRD execution status. Replaces manual TaskOutput queries. Shows progress, status, and summary.",
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
          },
        },
      },
      {
        name: "ralph_get",
        description: "Get detailed status of a single PRD execution including all user stories.",
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
          },
          required: ["branch", "storyId", "passes"],
        },
      },
      {
        name: "ralph_stop",
        description: "Stop PRD execution. Optionally clean up worktree.",
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
