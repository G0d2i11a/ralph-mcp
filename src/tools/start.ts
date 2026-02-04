import { z } from "zod";
import { parsePrdFile } from "../utils/prd-parser.js";
import { generateAgentPrompt } from "../utils/agent.js";
import { resolve } from "path";
import {
  areDependenciesSatisfied,
  updateExecution,
} from "../store/state.js";
import { createExecutionFromPrd } from "../utils/execution.js";

export const startInputSchema = z.object({
  prdPath: z.string().describe("Path to the PRD markdown file"),
  projectRoot: z.string().optional().describe("Project root directory (defaults to cwd)"),
  worktree: z.boolean().default(true).describe("Create a worktree for isolation"),
  autoStart: z.boolean().default(true).describe("Generate agent prompt for auto-start"),
  autoMerge: z.boolean().default(true).describe("Auto add to merge queue when all stories pass"),
  notifyOnComplete: z.boolean().default(true).describe("Show Windows notification when all stories complete"),
  onConflict: z
    .enum(["auto_theirs", "auto_ours", "notify", "agent"])
    .default("agent")
    .describe("Conflict resolution strategy for merge"),
  contextInjectionPath: z
    .string()
    .optional()
    .describe("Path to a file (e.g., CLAUDE.md) to inject into the agent prompt"),
  ignoreDependencies: z
    .boolean()
    .default(false)
    .describe("Skip dependency check and start even if dependencies are not satisfied"),
  queueIfBlocked: z
    .boolean()
    .default(false)
    .describe("If dependencies are not satisfied, create a pending execution instead of failing (default: false)"),
});

export type StartInput = z.infer<typeof startInputSchema>;

export interface StartResult {
  executionId: string;
  branch: string;
  worktreePath: string | null;
  agentPrompt: string | null;
  dependencies: string[];
  dependenciesSatisfied: boolean;
  pendingDependencies: string[];
  stories: Array<{
    storyId: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    priority: number;
    passes: boolean;
  }>;
}

export async function start(input: StartInput): Promise<StartResult> {
  const projectRoot = input.projectRoot || process.cwd();
  const prdPath = resolve(projectRoot, input.prdPath);

  // If the Runner is enabled (default), we intentionally do NOT return an agent prompt.
  // This prevents users from starting PRDs outside the Runner and bypassing concurrency control.
  // Manual prompt generation remains available when the Runner is explicitly disabled.
  const manualStartMode = process.env.RALPH_AUTO_RUNNER === "false";

  // Parse PRD file
  const prd = parsePrdFile(prdPath);

  // Check dependencies BEFORE creating worktree
  const depStatus = await areDependenciesSatisfied({
    dependencies: prd.dependencies,
    projectRoot,
    prdPath,
  });

  const canStartNow = depStatus.satisfied || input.ignoreDependencies;

  if (!canStartNow && !input.queueIfBlocked) {
    throw new Error(
      `Cannot start: dependencies not satisfied. Pending: [${depStatus.pending.join(", ")}]. ` +
      `Wait for these PRDs to complete, use queueIfBlocked: true to queue this PRD, ` +
      `or use ignoreDependencies: true to force start.`
    );
  }

  const created = await createExecutionFromPrd({
    projectRoot,
    prdPath,
    prd,
    worktree: input.worktree,
    onConflict: input.onConflict,
    autoMerge: input.autoMerge,
    notifyOnComplete: input.notifyOnComplete,
    status: canStartNow ? "ready" : "pending",
  });

  // Generate agent prompt if auto-start is enabled and dependencies are satisfied
  // (or ignoreDependencies=true).
  let agentPrompt: string | null = null;
  if (manualStartMode && input.autoStart && canStartNow) {
    await updateExecution(created.executionId, {
      status: "starting",
      launchAttemptAt: new Date(),
      launchAttempts: 1,
      updatedAt: new Date(),
    });

    const contextPath = input.contextInjectionPath
      ? resolve(projectRoot, input.contextInjectionPath)
      : undefined;

    agentPrompt = generateAgentPrompt(
      prd.branchName,
      prd.description,
      created.worktreePath || projectRoot,
      created.stories,
      contextPath
    );
  }

  return {
    executionId: created.executionId,
    branch: prd.branchName,
    worktreePath: created.worktreePath,
    agentPrompt,
    dependencies: prd.dependencies,
    dependenciesSatisfied: depStatus.satisfied,
    pendingDependencies: depStatus.pending,
    stories: created.stories,
  };
}
