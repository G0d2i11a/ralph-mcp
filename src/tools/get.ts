import { z } from "zod";
import {
  findExecutionByBranch,
  listUserStoriesByExecutionId,
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
  }>;
  progress: {
    completed: number;
    total: number;
    percentage: number;
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
    stories: stories.map((s) => ({
      storyId: s.storyId,
      title: s.title,
      description: s.description,
      acceptanceCriteria: s.acceptanceCriteria,
      priority: s.priority,
      passes: s.passes,
      notes: s.notes,
    })),
    progress: {
      completed,
      total,
      percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
    },
  };
}
