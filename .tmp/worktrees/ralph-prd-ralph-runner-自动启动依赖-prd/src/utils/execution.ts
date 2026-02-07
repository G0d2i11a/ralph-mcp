import { randomUUID } from "crypto";
import { basename } from "path";
import type { ParsedPrd } from "./prd-parser.js";
import { createWorktree } from "./worktree.js";
import {
  type ConflictStrategy,
  type ExecutionStatus,
  findExecutionByBranch,
  insertExecution,
  insertUserStories,
} from "../store/state.js";

export interface CreatedStorySummary {
  storyId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  passes: boolean;
}

export interface CreateExecutionParams {
  projectRoot: string;
  prdPath: string;
  prd: ParsedPrd;
  worktree: boolean;
  status?: ExecutionStatus;
  onConflict: ConflictStrategy;
  autoMerge: boolean;
  notifyOnComplete: boolean;
}

export interface CreateExecutionResult {
  executionId: string;
  branch: string;
  project: string;
  worktreePath: string | null;
  stories: CreatedStorySummary[];
}

export async function createExecutionFromPrd(
  input: CreateExecutionParams
): Promise<CreateExecutionResult> {
  const existing = await findExecutionByBranch(input.prd.branchName);
  if (existing) {
    throw new Error(
      `Execution already exists for branch ${input.prd.branchName}. Use ralph_get to check status or ralph_stop to stop it.`
    );
  }

  // Create worktree if requested
  let worktreePath: string | null = null;
  if (input.worktree) {
    worktreePath = await createWorktree(input.projectRoot, input.prd.branchName);
  }

  // Create execution record
  const executionId = randomUUID();
  const now = new Date();
  const projectName = basename(input.projectRoot);

  await insertExecution({
    id: executionId,
    project: projectName,
    branch: input.prd.branchName,
    description: input.prd.description,
    prdPath: input.prdPath,
    projectRoot: input.projectRoot,
    worktreePath: worktreePath,
    status: input.status ?? "pending",
    agentTaskId: null,
    onConflict: input.onConflict,
    autoMerge: input.autoMerge,
    notifyOnComplete: input.notifyOnComplete,
    dependencies: input.prd.dependencies,
    // Stagnation detection fields
    loopCount: 0,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastError: null,
    lastFilesChanged: 0,
    // Launch recovery fields
    launchAttemptAt: null,
    launchAttempts: 0,
    createdAt: now,
    updatedAt: now,
  });

  // Create user story records
  const storyRecords = input.prd.userStories.map((story) => ({
    id: `${executionId}:${story.id}`,
    executionId: executionId,
    storyId: story.id,
    title: story.title,
    description: story.description,
    acceptanceCriteria: story.acceptanceCriteria,
    priority: story.priority,
    passes: false,
    notes: "",
    acEvidence: {} as Record<string, import("../store/state.js").AcEvidence>,
  }));

  if (storyRecords.length > 0) {
    await insertUserStories(storyRecords);
  }

  return {
    executionId,
    branch: input.prd.branchName,
    project: projectName,
    worktreePath,
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

