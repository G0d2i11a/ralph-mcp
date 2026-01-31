import { z } from "zod";
import notifier from "node-notifier";
import { appendFile, mkdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname, resolve } from "path";
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

const acEvidenceSchema = z.object({
  passes: z.boolean(),
  evidence: z.string().optional(),
  command: z.string().optional(),
  output: z.string().optional(),
  blockedReason: z.string().optional(),
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
  triggeredDependents: Array<{
    branch: string;
    agentPrompt: string | null;
  }>;
  stagnation?: {
    isStagnant: boolean;
    type: string | null;
    message: string;
  };
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
      triggeredDependents: [],
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
  const triggeredDependents: Array<{ branch: string; agentPrompt: string | null }> = [];
  if (allComplete) {
    const dependents = await findExecutionsDependingOn(exec.branch);

    for (const dep of dependents) {
      // Skip if already running or completed
      if (dep.status !== "pending") {
        continue;
      }

      // Check if all dependencies are now satisfied
      const depStatus = await areDependenciesSatisfied(dep);

      if (depStatus.satisfied) {
        // Get user stories for this dependent execution
        const depStories = await listUserStoriesByExecutionId(dep.id);

        // Generate agent prompt for the dependent
        const agentPrompt = generateAgentPrompt(
          dep.branch,
          dep.description,
          dep.worktreePath || dep.projectRoot,
          depStories.map((s) => ({
            storyId: s.storyId,
            title: s.title,
            description: s.description,
            acceptanceCriteria: s.acceptanceCriteria,
            priority: s.priority,
            passes: s.passes,
          })),
          undefined // contextPath not stored, would need to re-parse PRD if needed
        );

        triggeredDependents.push({
          branch: dep.branch,
          agentPrompt,
        });
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
    triggeredDependents,
  };
}
