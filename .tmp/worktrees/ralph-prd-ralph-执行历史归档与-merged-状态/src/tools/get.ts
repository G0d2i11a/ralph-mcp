import { z } from "zod";
import {
  findExecutionByBranch,
  listUserStoriesByExecutionId,
  AcEvidence,
} from "../store/state.js";

export const getInputSchema = z.object({
  branch: z.string().describe("Branch name (e.g., ralph/task1-agent)"),
});

export type GetInput = z.infer<typeof getInputSchema>;

export interface GetResult {
  execution: {
    id: string;
    project: string;
    branch: string;
    description: string;
    prdPath: string;
    projectRoot: string;
    worktreePath: string | null;
    status: string;
    agentTaskId: string | null;
    onConflict: string | null;
    createdAt: string;
    updatedAt: string;
  };
  stories: Array<{
    storyId: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    priority: number;
    passes: boolean;
    notes: string | null;
    acEvidence: Record<string, AcEvidence>;
    acStatus: string; // e.g., "2/3 AC passing"
  }>;
  progress: {
    completed: number;
    total: number;
    percentage: number;
  };
  stagnation: {
    loopCount: number;
    consecutiveNoProgress: number;
    consecutiveErrors: number;
    lastError: string | null;
    isAtRisk: boolean;
    riskReason: string | null;
  };
}

export async function get(input: GetInput): Promise<GetResult> {
  // Find execution by branch
  const exec = await findExecutionByBranch(input.branch);

  if (!exec) {
    throw new Error(`No execution found for branch: ${input.branch}`);
  }

  // Get stories
  const stories = await listUserStoriesByExecutionId(exec.id);

  // Sort by priority
  stories.sort((a, b) => a.priority - b.priority);

  const completed = stories.filter((s) => s.passes).length;
  const total = stories.length;

  // Calculate stagnation risk
  const loopCount = exec.loopCount ?? 0;
  const consecutiveNoProgress = exec.consecutiveNoProgress ?? 0;
  const consecutiveErrors = exec.consecutiveErrors ?? 0;
  const lastError = exec.lastError ?? null;

  let isAtRisk = false;
  let riskReason: string | null = null;

  if (consecutiveNoProgress >= 2) {
    isAtRisk = true;
    riskReason = `No file changes for ${consecutiveNoProgress} consecutive updates (threshold: 3)`;
  } else if (consecutiveErrors >= 3) {
    isAtRisk = true;
    riskReason = `Same error repeated ${consecutiveErrors} times (threshold: 5)`;
  }

  return {
    execution: {
      id: exec.id,
      project: exec.project,
      branch: exec.branch,
      description: exec.description,
      prdPath: exec.prdPath,
      projectRoot: exec.projectRoot,
      worktreePath: exec.worktreePath,
      status: exec.status,
      agentTaskId: exec.agentTaskId,
      onConflict: exec.onConflict,
      createdAt: exec.createdAt.toISOString(),
      updatedAt: exec.updatedAt.toISOString(),
    },
    stories: stories.map((s) => {
      const acEvidence = s.acEvidence || {};
      const totalAc = s.acceptanceCriteria.length;
      const passingAc = Object.values(acEvidence).filter((ev) => ev.passes).length;
      const acStatus = totalAc > 0 ? `${passingAc}/${totalAc} AC passing` : "No AC defined";

      return {
        storyId: s.storyId,
        title: s.title,
        description: s.description,
        acceptanceCriteria: s.acceptanceCriteria,
        priority: s.priority,
        passes: s.passes,
        notes: s.notes,
        acEvidence,
        acStatus,
      };
    }),
    progress: {
      completed,
      total,
      percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
    },
    stagnation: {
      loopCount,
      consecutiveNoProgress,
      consecutiveErrors,
      lastError,
      isAtRisk,
      riskReason,
    },
  };
}
