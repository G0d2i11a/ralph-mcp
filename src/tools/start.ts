import { z } from "zod";
import { randomUUID } from "crypto";
import { parsePrdFile } from "../utils/prd-parser.js";
import { createWorktree } from "../utils/worktree.js";
import { generateAgentPrompt } from "../utils/agent.js";
import { resolve, basename } from "path";
import {
  findExecutionByBranch,
  insertExecution,
  insertUserStories,
} from "../store/state.js";

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
});

export type StartInput = z.infer<typeof startInputSchema>;

export interface StartResult {
  executionId: string;
  branch: string;
  worktreePath: string | null;
  agentPrompt: string | null;
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

  // Parse PRD file
  const prd = parsePrdFile(prdPath);

  // Check if execution already exists for this branch
  const existing = await findExecutionByBranch(prd.branchName);

  if (existing) {
    throw new Error(
      `Execution already exists for branch ${prd.branchName}. Use ralph_get to check status or ralph_stop to stop it.`
    );
  }

  // Create worktree if requested
  let worktreePath: string | null = null;
  if (input.worktree) {
    worktreePath = await createWorktree(projectRoot, prd.branchName);
  }

  // Create execution record
  const executionId = randomUUID();
  const now = new Date();
  const projectName = basename(projectRoot);

  await insertExecution({
    id: executionId,
    project: projectName,
    branch: prd.branchName,
    description: prd.description,
    prdPath: prdPath,
    projectRoot: projectRoot,
    worktreePath: worktreePath,
    status: "pending",
    agentTaskId: null,
    onConflict: input.onConflict,
    autoMerge: input.autoMerge,
    notifyOnComplete: input.notifyOnComplete,
    createdAt: now,
    updatedAt: now,
  });

  // Create user story records
  const storyRecords = prd.userStories.map((story) => ({
    id: `${executionId}:${story.id}`,
    executionId: executionId,
    storyId: story.id,
    title: story.title,
    description: story.description,
    acceptanceCriteria: story.acceptanceCriteria,
    priority: story.priority,
    passes: false,
    notes: "",
  }));

  if (storyRecords.length > 0) {
    await insertUserStories(storyRecords);
  }

  // Generate agent prompt if auto-start
  let agentPrompt: string | null = null;
  if (input.autoStart) {
    agentPrompt = generateAgentPrompt(
      prd.branchName,
      prd.description,
      worktreePath || projectRoot,
      storyRecords.map((s) => ({
        storyId: s.storyId,
        title: s.title,
        description: s.description,
        acceptanceCriteria: s.acceptanceCriteria,
        priority: s.priority,
        passes: s.passes,
      }))
    );
  }

  return {
    executionId,
    branch: prd.branchName,
    worktreePath,
    agentPrompt,
    stories: storyRecords.map((s) => ({
      storyId: s.storyId,
      title: s.title,
      description: s.description,
      acceptanceCriteria: s.acceptanceCriteria,
      priority: s.priority,
      passes: s.passes,
    })),
  };
}
