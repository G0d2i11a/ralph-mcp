import { z } from "zod";
import notifier from "node-notifier";
import { appendFile, mkdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import {
  areDependenciesSatisfied,
  findExecutionByBranch,
  findExecutionsDependingOn,
  findMergeQueueItemByExecutionId,
  findUserStoryById,
  insertMergeQueueItem,
  listMergeQueue,
  listUserStoriesByExecutionId,
  recordLoopResult,
  updateExecution,
  updateUserStory,
  AcEvidence,
} from "../store/state.js";
import { mergeQueueAction } from "./merge.js";
import { generateAgentPrompt } from "../utils/agent.js";
import { syncMainToBranch } from "../utils/merge-helpers.js";

const execAsync = promisify(exec);

const acEvidenceSchema = z.object({
  passes: z.boolean(),
  evidence: z.string().optional(),
  command: z.string().optional(),
  output: z.string().optional(),
  blockedReason: z.string().optional(),
});

const fileExplanationSchema = z.object({
  file: z.string(),
  reason: z.string(),
  lines: z.number(),
});

const unexpectedFileExplanationSchema = z.object({
  file: z.string(),
  reason: z.string().describe("Why this file was changed even though it wasn't in expectedFiles"),
  isNewFile: z.boolean().optional().describe("Whether this is a newly created file"),
  isNewDirectory: z.boolean().optional().describe("Whether this file is in a newly created directory"),
});

export const updateInputSchema = z.object({
  branch: z.string().describe("Branch name (e.g., ralph/task1-agent)"),
  storyId: z.string().describe("Story ID (e.g., US-001)"),
  passes: z.boolean().describe("Whether the story passes"),
  notes: z.string().optional().describe("Implementation notes"),
  filesChanged: z.number().optional().describe("Number of files changed (for stagnation detection)"),
  error: z.string().optional().describe("Error message if stuck (for stagnation detection)"),
  acEvidence: z.record(acEvidenceSchema).optional().describe("Per-AC evidence mapping (e.g., {'AC-1': {passes: true, evidence: '...', command: '...', output: '...'}})"),
  typecheckPassed: z.boolean().optional().describe("Whether typecheck passed (required for passes: true)"),
  buildPassed: z.boolean().optional().describe("Whether build passed (required for passes: true)"),
  scopeExplanation: z.array(fileExplanationSchema).optional().describe("Explanation for large changes (required if >1500 lines or >15 files)"),
  expectedFiles: z.array(z.string()).optional().describe("Pre-declared list of files expected to be changed (declare before implementation)"),
  unexpectedFileExplanation: z.array(unexpectedFileExplanationSchema).optional().describe("Explanation for files changed that weren't in expectedFiles"),
});

export type UpdateInput = z.infer<typeof updateInputSchema>;

export interface UpdateResult {
  success: boolean;
  branch: string;
  storyId: string;
  passes: boolean;
  allComplete: boolean;
  progress: string;
  addedToMergeQueue: boolean;
  /** Dependents that were marked as ready (dependencies satisfied, worktree synced) */
  readyDependents: Array<{
    branch: string;
    syncSuccess: boolean;
    syncError?: string;
  }>;
  stagnation?: {
    isStagnant: boolean;
    type: string | null;
    message: string;
  };
  scopeGuardrail?: {
    triggered: boolean;
    type: "warn" | "hard" | null;
    totalLines: number;
    totalFiles: number;
    message: string;
  };
  diffReconciliation?: {
    triggered: boolean;
    expectedFiles: string[];
    actualFiles: string[];
    unexpectedFiles: string[];
    missingFiles: string[];
    divergencePercent: number;
    message: string;
  };
}

// Scope guardrail thresholds
const SCOPE_WARN_LINES = 1500;
const SCOPE_WARN_FILES = 15;
const SCOPE_HARD_LINES = 3000;
const SCOPE_HARD_FILES = 25;

// Files to exclude from scope analysis
const EXCLUDED_FILES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  '.snap',
  '.lock',
  'dist/',
  'build/',
  '.next/',
  'node_modules/',
];

function shouldExcludeFile(filePath: string): boolean {
  return EXCLUDED_FILES.some(pattern => filePath.includes(pattern));
}

interface DiffStats {
  totalLines: number;
  totalFiles: number;
  files: Array<{ file: string; added: number; deleted: number; total: number }>;
}

async function analyzeDiffStats(worktreePath: string): Promise<DiffStats> {
  try {
    // Compare against main branch to track cumulative changes across the entire PRD execution
    // This is important because the agent commits BEFORE calling ralph_update,
    // so `git diff HEAD` would show 0 changes. We need to compare against the base branch.
    // Try main first, then master, then fall back to HEAD (uncommitted changes only)
    let stdout = "";
    let baseBranch = "main";

    try {
      const result = await execAsync('git diff --numstat main...HEAD', { cwd: worktreePath });
      stdout = result.stdout;
    } catch {
      try {
        const result = await execAsync('git diff --numstat master...HEAD', { cwd: worktreePath });
        stdout = result.stdout;
        baseBranch = "master";
      } catch {
        // Fall back to uncommitted changes if no main/master branch
        const result = await execAsync('git diff --numstat HEAD', { cwd: worktreePath });
        stdout = result.stdout;
        baseBranch = "HEAD";
      }
    }

    const files: Array<{ file: string; added: number; deleted: number; total: number }> = [];
    let totalLines = 0;

    for (const line of stdout.trim().split('\n')) {
      if (!line) continue;

      const [added, deleted, file] = line.split('\t');

      // Skip excluded files
      if (shouldExcludeFile(file)) continue;

      // Skip binary files (shown as '-' in git diff --numstat)
      if (added === '-' || deleted === '-') continue;

      const addedNum = parseInt(added, 10);
      const deletedNum = parseInt(deleted, 10);
      const total = addedNum + deletedNum;

      files.push({ file, added: addedNum, deleted: deletedNum, total });
      totalLines += total;
    }

    return {
      totalLines,
      totalFiles: files.length,
      files,
    };
  } catch (error) {
    // If git diff fails, return empty stats
    return { totalLines: 0, totalFiles: 0, files: [] };
  }
}

function formatDate(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const yyyy = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const HH = pad(date.getHours());
  const mm = pad(date.getMinutes());
  return `${yyyy}-${MM}-${dd} ${HH}:${mm}`;
}

/**
 * Extract Codebase Pattern from notes if present.
 * Looks for "**Codebase Pattern:**" section in the notes.
 */
function extractCodebasePattern(notes: string): string | null {
  const match = notes.match(/\*\*Codebase Pattern:\*\*\s*(.+?)(?=\n\*\*|\n##|$)/is);
  if (match && match[1].trim()) {
    return match[1].trim();
  }
  return null;
}

/**
 * Update the Codebase Patterns section at the top of ralph-progress.md.
 * Creates the section if it doesn't exist.
 */
async function updateCodebasePatterns(progressPath: string, newPattern: string): Promise<void> {
  let content = "";
  if (existsSync(progressPath)) {
    content = await readFile(progressPath, "utf-8");
  }

  const patternsSectionHeader = "## Codebase Patterns\n";
  const patternLine = `- ${newPattern}\n`;

  if (content.includes(patternsSectionHeader)) {
    // Find the end of the Codebase Patterns section (next ## or end of patterns)
    const sectionStart = content.indexOf(patternsSectionHeader);
    const sectionContentStart = sectionStart + patternsSectionHeader.length;

    // Find next section (## that's not Codebase Patterns)
    const nextSectionMatch = content.slice(sectionContentStart).match(/\n## /);
    const sectionEnd = nextSectionMatch
      ? sectionContentStart + nextSectionMatch.index!
      : content.length;

    // Check if pattern already exists (avoid duplicates)
    const existingPatterns = content.slice(sectionContentStart, sectionEnd);
    if (!existingPatterns.includes(newPattern)) {
      // Insert new pattern at the end of the patterns section
      const before = content.slice(0, sectionEnd);
      const after = content.slice(sectionEnd);
      content = before + patternLine + after;
      await writeFile(progressPath, content, "utf-8");
    }
  } else {
    // Create new Codebase Patterns section at the top
    const newSection = patternsSectionHeader + patternLine + "\n";
    content = newSection + content;
    await writeFile(progressPath, content, "utf-8");
  }
}

export async function update(input: UpdateInput): Promise<UpdateResult> {
  // Find execution by branch
  const exec = await findExecutionByBranch(input.branch);

  if (!exec) {
    throw new Error(`No execution found for branch: ${input.branch}`);
  }

  // Find and update the story
  const storyKey = `${exec.id}:${input.storyId}`;
  const story = await findUserStoryById(storyKey);

  if (!story) {
    throw new Error(
      `No story found with ID ${input.storyId} for branch ${input.branch}`
    );
  }

  // SCOPE GUARDRAIL: Analyze diff stats if worktree exists
  let scopeGuardrail: UpdateResult["scopeGuardrail"] = undefined;
  if (exec.worktreePath && existsSync(exec.worktreePath)) {
    const diffStats = await analyzeDiffStats(exec.worktreePath);

    // Check hard threshold
    if (diffStats.totalLines > SCOPE_HARD_LINES || diffStats.totalFiles > SCOPE_HARD_FILES) {
      throw new Error(
        `SCOPE GUARDRAIL: Changes exceed hard threshold (${diffStats.totalLines} lines, ${diffStats.totalFiles} files). ` +
        `Hard limit: ${SCOPE_HARD_LINES} lines or ${SCOPE_HARD_FILES} files. ` +
        `This story is too large and must be split into smaller stories. ` +
        `Top changed files:\n${diffStats.files.slice(0, 10).map(f => `  - ${f.file}: ${f.total} lines`).join('\n')}`
      );
    }

    // Check warn threshold
    if (diffStats.totalLines > SCOPE_WARN_LINES || diffStats.totalFiles > SCOPE_WARN_FILES) {
      // Require explanation
      if (!input.scopeExplanation || input.scopeExplanation.length === 0) {
        throw new Error(
          `SCOPE GUARDRAIL: Changes exceed warn threshold (${diffStats.totalLines} lines, ${diffStats.totalFiles} files). ` +
          `Warn threshold: ${SCOPE_WARN_LINES} lines or ${SCOPE_WARN_FILES} files. ` +
          `You must provide scopeExplanation with structured justification:\n` +
          `scopeExplanation: [{ file: "path/to/file.ts", reason: "why in scope", lines: 123 }, ...]\n\n` +
          `Changed files:\n${diffStats.files.map(f => `  - ${f.file}: ${f.total} lines`).join('\n')}`
        );
      }

      // Validate explanation covers significant files
      const explainedFiles = new Set(input.scopeExplanation.map(e => e.file));
      const significantFiles = diffStats.files.filter(f => f.total > 50);
      const missingExplanations = significantFiles.filter(f => !explainedFiles.has(f.file));

      if (missingExplanations.length > 0) {
        throw new Error(
          `SCOPE GUARDRAIL: Missing explanations for significant files:\n` +
          `${missingExplanations.slice(0, 5).map(f => `  - ${f.file}: ${f.total} lines`).join('\n')}\n\n` +
          `Please provide scopeExplanation for all files with >50 lines changed.`
        );
      }

      scopeGuardrail = {
        triggered: true,
        type: "warn",
        totalLines: diffStats.totalLines,
        totalFiles: diffStats.totalFiles,
        message: `Warn threshold exceeded. Explanation provided for ${input.scopeExplanation.length} files.`,
      };
    }
  }

  // DIFF RECONCILIATION: Compare expected vs actual files changed
  let diffReconciliation: UpdateResult["diffReconciliation"] = undefined;
  if (exec.worktreePath && existsSync(exec.worktreePath) && input.expectedFiles && input.expectedFiles.length > 0) {
    const diffStats = await analyzeDiffStats(exec.worktreePath);
    const actualFiles = diffStats.files.map(f => f.file);
    const expectedSet = new Set(input.expectedFiles);
    const actualSet = new Set(actualFiles);

    // Find unexpected files (in actual but not in expected)
    const unexpectedFiles = actualFiles.filter(f => !expectedSet.has(f));

    // Find missing files (in expected but not in actual)
    const missingFiles = input.expectedFiles.filter(f => !actualSet.has(f));

    // Calculate divergence percentage
    const totalUnique = new Set([...input.expectedFiles, ...actualFiles]).size;
    const divergencePercent = totalUnique > 0
      ? Math.round(((unexpectedFiles.length + missingFiles.length) / totalUnique) * 100)
      : 0;

    // Check if unexpected files need explanation
    if (unexpectedFiles.length > 0) {
      const explainedUnexpected = new Set(
        (input.unexpectedFileExplanation || []).map(e => e.file)
      );
      const unexplainedFiles = unexpectedFiles.filter(f => !explainedUnexpected.has(f));

      if (unexplainedFiles.length > 0) {
        // Check if any are new files (not in git history before this branch)
        throw new Error(
          `DIFF RECONCILIATION: Unexpected files changed that weren't in expectedFiles:\n` +
          `${unexplainedFiles.slice(0, 10).map(f => `  - ${f}`).join('\n')}\n\n` +
          `You must either:\n` +
          `1. Add these files to expectedFiles before implementation, OR\n` +
          `2. Provide unexpectedFileExplanation: [{ file: "path", reason: "why changed", isNewFile: true/false }]`
        );
      }
    }

    // Warn if divergence is too high (>50%)
    if (divergencePercent > 50) {
      throw new Error(
        `DIFF RECONCILIATION: Declaration vs actual divergence too high (${divergencePercent}%).\n` +
        `Expected files: ${input.expectedFiles.length}\n` +
        `Actual files: ${actualFiles.length}\n` +
        `Unexpected: ${unexpectedFiles.length} files\n` +
        `Missing: ${missingFiles.length} files\n\n` +
        `This suggests the implementation scope changed significantly from the plan.\n` +
        `Please re-evaluate the story scope and update expectedFiles accordingly.`
      );
    }

    diffReconciliation = {
      triggered: unexpectedFiles.length > 0 || missingFiles.length > 0,
      expectedFiles: input.expectedFiles,
      actualFiles,
      unexpectedFiles,
      missingFiles,
      divergencePercent,
      message: divergencePercent > 0
        ? `Divergence: ${divergencePercent}%. Unexpected: ${unexpectedFiles.length}, Missing: ${missingFiles.length}`
        : "Declaration matches actual changes",
    };
  }

  // VALIDATION: Enforce typecheck and build requirements for passes: true
  if (input.passes) {
    if (input.typecheckPassed !== true) {
      throw new Error(
        `Cannot mark story as passing: typecheck must pass. Run 'pnpm check-types' and provide typecheckPassed: true`
      );
    }
    if (input.buildPassed !== true) {
      throw new Error(
        `Cannot mark story as passing: build must pass. Run 'pnpm build' and provide buildPassed: true`
      );
    }
  }

  // Process AC evidence
  let acEvidence: Record<string, AcEvidence> = input.acEvidence || {};

  // If passes: true but no evidence provided, auto-generate minimal evidence
  if (input.passes && Object.keys(acEvidence).length === 0) {
    // Generate AC keys from story's acceptance criteria
    story.acceptanceCriteria.forEach((_, index) => {
      const acKey = `AC-${index + 1}`;
      acEvidence[acKey] = {
        passes: true,
        evidence: "Verified via typecheck and build",
      };
    });
  }

  // If passes: false, mark all ACs without evidence as not passing
  if (!input.passes) {
    story.acceptanceCriteria.forEach((_, index) => {
      const acKey = `AC-${index + 1}`;
      if (!acEvidence[acKey]) {
        acEvidence[acKey] = {
          passes: false,
          blockedReason: input.error || "Story incomplete",
        };
      }
    });
  }

  // Record loop result for stagnation detection
  const filesChanged = input.filesChanged ?? 0;
  const error = input.error ?? null;
  const stagnationResult = await recordLoopResult(exec.id, filesChanged, error);

  // If stagnant, mark execution as failed and return early
  if (stagnationResult.isStagnant) {
    return {
      success: false,
      branch: input.branch,
      storyId: input.storyId,
      passes: false,
      allComplete: false,
      progress: `Stagnation detected`,
      addedToMergeQueue: false,
      readyDependents: [],
      stagnation: {
        isStagnant: true,
        type: stagnationResult.type,
        message: stagnationResult.message,
      },
    };
  }

  // Update story with evidence
  await updateUserStory(storyKey, {
    passes: input.passes,
    notes: input.notes || story.notes,
    acEvidence,
  });

  // Append to ralph-progress.md if passed
  if (input.passes && exec.worktreePath) {
    try {
      const progressPath = join(exec.worktreePath, "ralph-progress.md");
      const dir = dirname(progressPath);

      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      const timestamp = formatDate(new Date());
      const notesContent = input.notes || story.notes || "No notes provided.";
      const entry = `## [${timestamp}] ${story.storyId}: ${story.title}\n${notesContent}\n\n`;

      // Extract and consolidate Codebase Pattern if present
      const pattern = extractCodebasePattern(notesContent);
      if (pattern) {
        await updateCodebasePatterns(progressPath, pattern);
      }

      await appendFile(progressPath, entry, "utf-8");
    } catch (e) {
      console.error("Failed to write to ralph-progress.md:", e);
      // Continue execution even if logging fails
    }
  }

  // Update execution timestamp and status
  const allStories = await listUserStoriesByExecutionId(exec.id);

  // Check if this update completes all stories
  const updatedStories = allStories.map((s) =>
    s.id === storyKey ? { ...s, passes: input.passes } : s
  );
  const allComplete = updatedStories.every((s) => s.passes);
  const completedCount = updatedStories.filter((s) => s.passes).length;

  // Update execution status
  const newStatus = allComplete ? "completed" : "running";
  await updateExecution(exec.id, { status: newStatus, updatedAt: new Date() });

  // Auto add to merge queue if enabled and all complete
  let addedToMergeQueue = false;
  if (allComplete && exec.autoMerge) {
    // Check if already in queue
    const existingInQueue = await findMergeQueueItemByExecutionId(exec.id);

    if (!existingInQueue) {
      const queue = await listMergeQueue();
      const maxPosition = queue.length > 0 ? Math.max(...queue.map((q) => q.position)) : 0;
      const nextPosition = maxPosition + 1;

      await insertMergeQueueItem({
        executionId: exec.id,
        position: nextPosition,
        status: "pending",
        createdAt: new Date(),
      });
      addedToMergeQueue = true;

      // Auto-process merge queue (fire and forget)
      setImmediate(async () => {
        try {
          await mergeQueueAction({ action: "process" });
        } catch (e) {
          console.error("Auto-merge failed:", e);
        }
      });
    }
  }

  // Send Windows toast notification when all complete (if enabled)
  if (allComplete && exec.notifyOnComplete) {
    notifier.notify({
      title: "Ralph PRD Complete",
      message: `${exec.branch} - All ${allStories.length} stories done!`,
      sound: true,
    });
  }

  // Trigger dependent executions when this PRD completes
  const readyDependents: Array<{ branch: string; syncSuccess: boolean; syncError?: string }> = [];
  if (allComplete) {
    const dependents = await findExecutionsDependingOn(exec.branch);

    for (const dep of dependents) {
      // Skip if not pending (already running, completed, etc.)
      if (dep.status !== "pending") {
        continue;
      }

      // Check if all dependencies are now satisfied
      const depStatus = await areDependenciesSatisfied(dep);

      if (depStatus.satisfied) {
        // Sync main to the dependent's worktree before marking as ready
        let syncSuccess = true;
        let syncError: string | undefined;

        if (dep.worktreePath) {
          try {
            const syncResult = await syncMainToBranch(dep.worktreePath, dep.branch);
            if (!syncResult.success) {
              syncSuccess = false;
              syncError = syncResult.message;
            }
          } catch (e) {
            syncSuccess = false;
            syncError = e instanceof Error ? e.message : String(e);
          }
        }

        if (syncSuccess) {
          // Mark as ready - Runner will pick it up
          await updateExecution(dep.id, {
            status: "ready",
            updatedAt: new Date(),
          });

          readyDependents.push({
            branch: dep.branch,
            syncSuccess: true,
          });
        } else {
          // Keep as pending if sync failed, record the error
          readyDependents.push({
            branch: dep.branch,
            syncSuccess: false,
            syncError,
          });
        }
      }
    }
  }

  return {
    success: true,
    branch: input.branch,
    storyId: input.storyId,
    passes: input.passes,
    allComplete,
    progress: `${completedCount}/${allStories.length} US`,
    addedToMergeQueue,
    readyDependents,
    scopeGuardrail,
    diffReconciliation,
  };
}
