import { randomUUID } from "crypto";
import { basename } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import type { ParsedPrd } from "./prd-parser.js";
import { DEFAULT_CONFIG } from "../config/schema.js";
import { createWorktree } from "./worktree.js";
import {
  type ConflictStrategy,
  type ExecutionStatus,
  findArchivedExecutionByBranch,
  findExecutionByBranch,
  insertExecutionAtomic,
} from "../store/state.js";

const execAsync = promisify(exec);

async function doesBranchExist(projectRoot: string, branch: string): Promise<boolean> {
  try {
    await execAsync(`git rev-parse --verify "${branch}"`, { cwd: projectRoot });
    return true;
  } catch {
    return false;
  }
}

async function ensureBranchExists(
  projectRoot: string,
  branch: string,
  baseRef: string
): Promise<void> {
  if (await doesBranchExist(projectRoot, branch)) return;
  await execAsync(`git branch "${branch}" "${baseRef}"`, { cwd: projectRoot });
}

async function getBranchHeadSha(
  projectRoot: string,
  branch: string
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`git rev-parse --verify "${branch}"`, { cwd: projectRoot });
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

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
  // Only check active executions - archived ones (completed/merged) can be re-executed
  const existing = await findExecutionByBranch(input.prd.branchName);
  if (existing) {
    throw new Error(
      `Execution already exists for branch ${input.prd.branchName} (status: ${existing.status}). ` +
        `Use ralph_get to check status or ralph_stop to stop it.`
    );
  }

  // For failed/stopped archives, suggest using ralph_retry instead of creating new
  const archived = await findArchivedExecutionByBranch(input.prd.branchName);
  if (archived && (archived.status === "failed" || archived.status === "stopped")) {
    throw new Error(
      `Found archived ${archived.status} execution for branch ${input.prd.branchName}. ` +
        `Use ralph_retry to resume it, or ralph_stop --deleteRecord to remove it first.`
    );
  }

  // Create worktree if requested
  let worktreePath: string | null = null;
  if (input.worktree) {
    worktreePath = await createWorktree(input.projectRoot, input.prd.branchName);
  } else {
    const mainBranch = DEFAULT_CONFIG.merge.mainBranch;
    await ensureBranchExists(input.projectRoot, input.prd.branchName, mainBranch);
  }

  const baseCommitSha = await getBranchHeadSha(input.projectRoot, input.prd.branchName);
  if (!baseCommitSha) {
    throw new Error(
      `Failed to resolve baseCommitSha for branch ${input.prd.branchName}. ` +
        `Ensure ${input.projectRoot} is a git repository and the branch can be created.`
    );
  }

  // Create execution record
  const executionId = randomUUID();
  const now = new Date();
  const projectName = basename(input.projectRoot);

  const executionRecord = {
    id: executionId,
    project: projectName,
    branch: input.prd.branchName,
    description: input.prd.description,
    priority: input.prd.priority ?? "P1",
    prdPath: input.prdPath,
    projectRoot: input.projectRoot,
    worktreePath: worktreePath,
    baseCommitSha,
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
    lastProgressAt: now,
    // Current activity tracking
    currentStoryId: null,
    currentStep: null,
    stepStartedAt: null,
    logPath: null,
    // Launch recovery fields
    launchAttemptAt: null,
    launchAttempts: 0,
    // Merge tracking fields
    mergedAt: null,
    mergeCommitSha: null,
    // Reconcile tracking
    reconcileReason: null,
    createdAt: now,
    updatedAt: now,
  };

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

  await insertExecutionAtomic(executionRecord, storyRecords);

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

