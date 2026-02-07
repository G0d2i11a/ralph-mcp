import { z } from "zod";
import { resolve } from "path";
import { execSync } from "child_process";
import { parsePrdFile } from "../utils/prd-parser.js";
import { generateAgentPrompt } from "../utils/agent.js";
import { createExecutionFromPrd } from "../utils/execution.js";
import {
  detectPackageManager,
  getInstallCommand,
  InstallCommand,
} from "../utils/package-manager.js";
import {
  areDependenciesSatisfied,
  updateExecution,
  ExecutionRecord,
} from "../store/state.js";

export const batchStartInputSchema = z.object({
  prdPaths: z.array(z.string()).describe("Array of paths to PRD markdown files"),
  projectRoot: z.string().optional().describe("Project root directory (defaults to cwd)"),
  worktree: z.boolean().default(true).describe("Create worktrees for isolation"),
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
  preheat: z.boolean().default(true).describe("Run install command serially before starting agents (avoids store lock)"),
});

export type BatchStartInput = z.infer<typeof batchStartInputSchema>;

interface PrdInfo {
  prdPath: string;
  branch: string;
  dependencies: string[];
  worktreePath: string | null;
  executionId: string;
  stories: Array<{
    storyId: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    priority: number;
    passes: boolean;
  }>;
}

export interface BatchStartResult {
  total: number;
  created: number;
  skipped: Array<{ prdPath: string; reason: string }>;
  readyToStart: Array<{
    branch: string;
    agentPrompt: string;
    dependencies: string[];
  }>;
  waitingForDependencies: Array<{
    branch: string;
    pendingDependencies: string[];
  }>;
  dependencyGraph: Record<string, string[]>;
  preheatCompleted: boolean;
}

/**
 * Topological sort to determine execution order based on dependencies.
 */
function topologicalSort(prds: PrdInfo[]): PrdInfo[] {
  const branchToPrd = new Map<string, PrdInfo>();
  for (const prd of prds) {
    branchToPrd.set(prd.branch, prd);
  }

  const visited = new Set<string>();
  const result: PrdInfo[] = [];

  function visit(branch: string) {
    if (visited.has(branch)) return;
    visited.add(branch);

    const prd = branchToPrd.get(branch);
    if (!prd) return;

    // Visit dependencies first
    for (const dep of prd.dependencies) {
      if (branchToPrd.has(dep)) {
        visit(dep);
      }
    }

    result.push(prd);
  }

  for (const prd of prds) {
    visit(prd.branch);
  }

  return result;
}

/**
 * Run install command in a worktree directory.
 */
function preheatWorktree(worktreePath: string, installCmd: InstallCommand): void {
  const cmd = `${installCmd.command} ${installCmd.args.join(" ")}`;
  try {
    execSync(cmd, {
      cwd: worktreePath,
      stdio: "pipe",
      timeout: 300000, // 5 minutes
    });
  } catch (error) {
    // Try fallback if available
    if (installCmd.fallbackArgs.length > 0) {
      const fallbackCmd = `${installCmd.command} ${installCmd.fallbackArgs.join(" ")}`;
      execSync(fallbackCmd, {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: 300000,
      });
    } else {
      throw error;
    }
  }
}

export async function batchStart(input: BatchStartInput): Promise<BatchStartResult> {
  const projectRoot = input.projectRoot || process.cwd();
  const contextPath = input.contextInjectionPath
    ? resolve(projectRoot, input.contextInjectionPath)
    : undefined;

  // Detect package manager
  const pm = detectPackageManager(projectRoot);
  const installCmd = getInstallCommand(pm);

  const skipped: Array<{ prdPath: string; reason: string }> = [];

  const prdInfos: PrdInfo[] = [];

  // Phase 1: Parse all PRDs and create execution records
  for (const prdPath of input.prdPaths) {
    const fullPath = resolve(projectRoot, prdPath);

    try {
      const prd = parsePrdFile(fullPath);
      const created = await createExecutionFromPrd({
        projectRoot,
        prdPath: fullPath,
        prd,
        worktree: input.worktree,
        onConflict: input.onConflict,
        autoMerge: input.autoMerge,
        notifyOnComplete: input.notifyOnComplete,
        status: "pending",
      });

      prdInfos.push({
        prdPath,
        branch: created.branch,
        dependencies: prd.dependencies,
        worktreePath: created.worktreePath,
        executionId: created.executionId,
        stories: created.stories,
      });
    } catch (error) {
      skipped.push({
        prdPath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Phase 2: Topological sort for preheat order
  const sortedPrds = topologicalSort(prdInfos);

  // Phase 3: Preheat worktrees serially (avoids store lock contention)
  let preheatCompleted = false;
  if (input.preheat && input.worktree) {
    for (const prd of sortedPrds) {
      if (prd.worktreePath) {
        try {
          preheatWorktree(prd.worktreePath, installCmd);
        } catch (error) {
          console.error(`Preheat failed for ${prd.branch}:`, error);
          // Continue with other worktrees
        }
      }
    }
    preheatCompleted = true;
  }

  // Phase 4: Determine which PRDs can start immediately
  const readyToStart: Array<{
    branch: string;
    agentPrompt: string;
    dependencies: string[];
  }> = [];

  const waitingForDependencies: Array<{
    branch: string;
    pendingDependencies: string[];
  }> = [];

  for (const prd of prdInfos) {
    const tempExec = { dependencies: prd.dependencies } as ExecutionRecord;
    const depStatus = await areDependenciesSatisfied(tempExec);

    if (depStatus.satisfied) {
      const agentPrompt = generateAgentPrompt(
        prd.branch,
        "", // description not stored in prdInfo
        prd.worktreePath || projectRoot,
        prd.stories,
        contextPath
      );

      // Mark as running immediately since we're returning the prompt
      await updateExecution(prd.executionId, {
        status: "running",
        updatedAt: new Date(),
      });

      readyToStart.push({
        branch: prd.branch,
        agentPrompt,
        dependencies: prd.dependencies,
      });
    } else {
      waitingForDependencies.push({
        branch: prd.branch,
        pendingDependencies: depStatus.pending,
      });
    }
  }

  // Build dependency graph for visualization
  const dependencyGraph: Record<string, string[]> = {};
  for (const prd of prdInfos) {
    dependencyGraph[prd.branch] = prd.dependencies;
  }

  return {
    total: input.prdPaths.length,
    created: prdInfos.length,
    skipped,
    readyToStart,
    waitingForDependencies,
    dependencyGraph,
    preheatCompleted,
  };
}
