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
  BlockedReason,
  ExecutionStatus,
  IntrospectionLog,
} from "../store/state.js";
import { mergeQueueAction } from "./merge.js";
import { generateAgentPrompt } from "../utils/agent.js";
import { syncMainToBranch } from "../utils/merge-helpers.js";

const blockedReasonSchema = z.object({
  type: z.enum(["environment", "dependency", "requirement"]).describe("Type of blocking issue"),
  description: z.string().describe("Detailed description of the blocking issue"),
  suggestedAction: z.string().describe("Suggested action to resolve the block"),
});

// US-006: Structured introspection log schema
const introspectionLogSchema = z.object({
  implemented: z.string().describe("Brief summary of what was implemented"),
  filesChanged: z.array(z.string()).describe("List of files that were modified"),
  learnings: z.string().describe("Key learnings from this implementation"),
  nextSteps: z.string().describe("What should be done next"),
  confidence: z.number().min(0).max(1).describe("0-1 confidence score for the implementation"),
});

export const updateInputSchema = z.object({
  branch: z.string().describe("Branch name (e.g., ralph/task1-agent)"),
  storyId: z.string().describe("Story ID (e.g., US-001)"),
  passes: z.boolean().describe("Whether the story passes"),
  blockedReason: blockedReasonSchema.optional().describe("Structured reason if blocked (when passes: false due to external blocker)"),
  notes: z.string().optional().describe("Implementation notes"),
  introspection: introspectionLogSchema.optional().describe("US-006: Structured introspection log with confidence score"),
  filesChanged: z.number().optional().describe("Number of files changed (for stagnation detection)"),
  error: z.string().optional().describe("Error mege if stuck (for stagnation detection)"),
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
  /** @deprecated Use readyDependents instead */
  triggeredDependents: Array<{
    branch: string;
    agentPrompt: string | null;
    blockedReason?: string;
  }>;
  /** Dependents that were marked as 'ready' for the Runner to pick up */
  readyDependents: Array<{
    branch: string;
    agentPrompt: string | null;
    blockedReason?: string;
  }>;
  stagnation?: {
    isStagnant: boolean;
    type: string | null;
    message: string;
    // US-004: Include warnings in stagnation result
    warnings?: Array<{
      type: "idle_retry" | "no_progress" | "repeated_error";
      message: string;
      severity: "warning" | "critical";
    }>;
  };
  // US-004: Stagnation warnings (even when not stagnant)
  stagnationWarnings?: Array<{
    type: "idle_retry" | "no_progress" | "repeated_error";
    message: string;
    severity: "warning" | "critical";
  }>;
  // US-006: Low confidence warning
  lowConfidenceWarning?: {
    consecutiveCount: number;
    lastConfidence: number;
    message: string;
    suggestIntervention: boolean;
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

  // Record loop result for stagnation detection (US-004: pass notes for similarity detection)
  // US-006: Also pass confidence from introspection for low confidence detection
  const filesChanged = input.filesChanged ?? 0;
  const error = input.error ?? null;
  const notes = input.notes ?? null;
  const confidence = input.introspection?.confidence ?? null;
  const stagnationResult = await recordLoopResult(exec.id, filesChanged, error, notes, confidence);

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
      readyDependents: [],
      stagnation: {
        isStagnant: true,
        type: stagnationResult.type,
        message: stagnationResult.message,
        warnings: stagnationResult.warnings,
      },
    };
  }

  // Auto-blocking logic: Check for consecutive failures with same error
  let autoBlockedReason: BlockedReason | null = null;
  const currentConsecutiveFailures = story.consecutiveFailures ?? 0;
  const lastFailureError = story.lastFailureError ?? null;

  if (!input.passes && error) {
    // Check if this is the same error as last time
    const isSameError = lastFailureError === error;
    const newConsecutiveFailures = isSameError ? currentConsecutiveFailures + 1 : 1;

    // Auto-block after 3 consecutive failures with the same error
    if (newConsecutiveFailures >= 3) {
      autoBlockedReason = {
        type: "environment",
        description: `Auto-blocked: Same error repeated ${newConsecutiveFailures} times: ${error.slice(0, 200)}`,
        suggestedAction: "Manual intervention required. Use ralph_retry with a hint to provide guidance, or investigate the root cause.",
      };
    }

    // Update story with failure tracking
    await updateUserStory(storyKey, {
      passes: input.passes,
      notes: input.notes || story.notes,
      blocked: !!(input.blockedReason || autoBlockedReason),
      blockedReason: input.blockedReason || autoBlockedReason || null,
      consecutiveFailures: newConsecutiveFailures,
      lastFailureError: error,
    });
  } else {
    // Success or no error - reset failure tracking
    await updateUserStory(storyKey, {
      passes: input.passes,
      notes: input.notes || story.notes,
      blocked: !!input.blockedReason,
      blockedReason: input.blockedReason || null,
      consecutiveFailures: 0,
      lastFailureError: null,
    });
  }

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

      // US-006: Enhanced format with introspection data
      let entry = `## [${timestamp}] ${story.storyId}: ${story.title}\n`;

      if (input.introspection) {
        // Add structured introspection section
        entry += `### Introspection\n`;
        entry += `- **Implemented:** ${input.introspection.implemented}\n`;
        entry += `- **Files Changed:** ${input.introspection.filesChanged.join(", ") || "None"}\n`;
        entry += `- **Learnings:** ${input.introspection.learnings}\n`;
        entry += `- **Next Steps:** ${input.introspection.nextSteps}\n`;
        entry += `- **Confidence:** ${(input.introspection.confidence * 100).toFixed(0)}%\n`;
        entry += `\n### Notes\n`;
      }

      entry += `${notesContent}\n\n`;

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
    s.id === storyKey ? { ...s, passes: input.passes, blocked: !!(input.blockedReason || autoBlockedReason) } : s
  );
  const allComplete = updatedStories.every((s) => s.passes);
  const hasBlocked = updatedStories.some((s) => s.blocked);
  const completedCount = updatedStories.filter((s) => s.passes).length;

  // Update execution status
  // If any story is blocked, mark execution as failed to stop automatic retries
  let newStatus: ExecutionStatus = "running";
  if (allComplete) {
    newStatus = "completed";
  } else if (hasBlocked) {
    newStatus = "failed";
  }
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
  // Mark dependents as 'ready' so the Runner can pick them up
  const triggeredDependents: Array<{ branch: string; agentPrompt: string | null; blockedReason?: string }> = [];
  if (allComplete) {
    const dependents = await findExecutionsDependingOn(exec.branch);

    for (const dep of dependents) {
      // Skip if already running, completed, or already ready
      if (dep.status !== "pending") {
        continue;
      }

      // Check if all dependencies are now satisfied
      const depStatus = await areDependenciesSatisfied(dep);

      if (depStatus.satisfied) {
        // Ensure dependent worktree is up-to-date before marking ready (best-effort).
        if (dep.worktreePath) {
          const sync = await syncMainToBranch(dep.worktreePath, dep.branch);
          if (!sync.success) {
            triggeredDependents.push({
              branch: dep.branch,
              agentPrompt: null,
              blockedReason: sync.message,
            });
            continue;
          }
        }

        // Mark the dependent as 'ready' for the Runner to pick up
        await updateExecution(dep.id, {
          status: "ready",
          updatedAt: new Date(),
        });

        // Get user stories for this dependent execution
        const depStories = await listUserStoriesByExecutionId(dep.id);

        // Generate agent prompt for the dependent (for manual start or logging)
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

  // Build result with US-004 stagnation warnings
  const result: UpdateResult = {
    success: true,
    branch: input.branch,
    storyId: input.storyId,
    passes: input.passes,
    allComplete,
    progress: `${completedCount}/${allStories.length} US`,
    addedToMergeQueue,
    triggeredDependents,
    readyDependents: triggeredDependents, // Same as triggeredDependents, now marked as ready
  };

  // US-004: Include stagnation warnings even when not stagnant
  if (stagnationResult.warnings && stagnationResult.warnings.length > 0) {
    result.stagnationWarnings = stagnationResult.warnings;
  }

  // US-006: Include low confidence warning
  if (stagnationResult.lowConfidenceWarning) {
    result.lowConfidenceWarning = stagnationResult.lowConfidenceWarning;
  }

  return result;
}
