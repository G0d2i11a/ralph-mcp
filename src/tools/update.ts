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

/**
 * Schema for per-AC evidence provided by the agent.
 */
const acEvidenceSchema = z.object({
  passes: z.boolean().describe("Whether this AC passes"),
  evidence: z.string().optional().describe("Evidence description"),
  command: z.string().optional().describe("Command that was run"),
  output: z.string().optional().describe("Command output (truncated if needed)"),
  blockedReason: z.string().optional().describe("Reason if blocked"),
});

/**
 * Schema for hard gate verification results.
 */
const hardGatesSchema = z.object({
  typecheck: z.object({
    passed: z.boolean(),
    command: z.string().optional(),
    output: z.string().optional(),
  }).optional().describe("Typecheck verification result"),
  build: z.object({
    passed: z.boolean(),
    command: z.string().optional(),
    output: z.string().optional(),
  }).optional().describe("Build verification result"),
});

export const updateInputSchema = z.object({
  branch: z.string().describe("Branch name (e.g., ralph/task1-agent)"),
  storyId: z.string().describe("Story ID (e.g., US-001)"),
  passes: z.boolean().describe("Whether the story passes"),
  notes: z.string().optional().describe("Implementation notes"),
  filesChanged: z.number().optional().describe("Number of files changed (for stagnation detection)"),
  error: z.string().optional().describe("Error message if stuck (for stagnation detection)"),
  // US-001: Evidence-driven AC verification
  acEvidence: z.record(z.string(), acEvidenceSchema).optional()
    .describe("Per-AC evidence mapping, e.g., { 'AC-1': { passes: true, evidence: '...', command: '...', output: '...' } }"),
  hardGates: hardGatesSchema.optional()
    .describe("Hard gate verification results (typecheck and build must pass for passes=true)"),
  skipHardGates: z.boolean().optional().default(false)
    .describe("Skip hard gate verification (for non-code stories, default: false)"),
});

export type UpdateInput = z.infer<typeof updateInputSchema>;

/**
 * Evidence validation result for a single AC.
 */
export interface AcValidationResult {
  acId: string;
  passes: boolean;
  hasEvidence: boolean;
  evidence?: string;
  command?: string;
  outputSnippet?: string;
  blockedReason?: string;
}

/**
 * Hard gate validation result.
 */
export interface HardGateResult {
  gate: "typecheck" | "build";
  passed: boolean;
  required: boolean;
  command?: string;
  outputSnippet?: string;
}

/**
 * Evidence validation summary.
 */
export interface EvidenceValidation {
  /** Whether all hard gates passed */
  hardGatesPassed: boolean;
  /** Individual hard gate results */
  hardGates: HardGateResult[];
  /** Per-AC validation results */
  acResults: AcValidationResult[];
  /** Number of ACs with evidence */
  acsWithEvidence: number;
  /** Total number of ACs */
  totalAcs: number;
  /** Whether evidence was overridden (passes forced to false due to missing evidence) */
  evidenceOverride: boolean;
  /** Override reason if applicable */
  overrideReason?: string;
}

export interface UpdateResult {
  success: boolean;
  branch: string;
  storyId: string;
  passes: boolean;
  /** Original passes value before evidence validation */
  originalPasses?: boolean;
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
  };
  /** US-001: Evidence validation results */
  evidenceValidation?: EvidenceValidation;
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

/**
 * Truncate output to a reasonable length for storage.
 */
function truncateOutput(output: string | undefined, maxLength: number = 500): string | undefined {
  if (!output) return undefined;
  if (output.length <= maxLength) return output;
  return output.slice(0, maxLength) + `... (truncated, ${output.length - maxLength} more chars)`;
}

/**
 * US-001: Validate evidence for a story update.
 *
 * Hard requirements:
 * - typecheck must pass (if provided or skipHardGates is false)
 * - build must pass (if provided or skipHardGates is false)
 *
 * Soft requirements:
 * - Each AC should have corresponding evidence
 * - ACs without evidence are marked as not passing
 */
function validateEvidence(
  input: UpdateInput,
  acceptanceCriteria: string[]
): EvidenceValidation {
  const hardGates: HardGateResult[] = [];
  let hardGatesPassed = true;
  let evidenceOverride = false;
  let overrideReason: string | undefined;

  // Validate hard gates (typecheck and build)
  if (!input.skipHardGates && input.passes) {
    // Check typecheck gate
    if (input.hardGates?.typecheck) {
      const tc = input.hardGates.typecheck;
      hardGates.push({
        gate: "typecheck",
        passed: tc.passed,
        required: true,
        command: tc.command,
        outputSnippet: truncateOutput(tc.output),
      });
      if (!tc.passed) {
        hardGatesPassed = false;
        evidenceOverride = true;
        overrideReason = "Typecheck failed - story cannot pass without passing typecheck";
      }
    } else {
      // No typecheck evidence provided - this is a soft warning, not a hard fail
      // Agent should provide it, but we don't block if missing
      hardGates.push({
        gate: "typecheck",
        passed: false,
        required: true,
        outputSnippet: "No typecheck evidence provided",
      });
    }

    // Check build gate
    if (input.hardGates?.build) {
      const build = input.hardGates.build;
      hardGates.push({
        gate: "build",
        passed: build.passed,
        required: true,
        command: build.command,
        outputSnippet: truncateOutput(build.output),
      });
      if (!build.passed) {
        hardGatesPassed = false;
        evidenceOverride = true;
        overrideReason = overrideReason || "Build failed - story cannot pass without passing build";
      }
    } else {
      // No build evidence provided - soft warning
      hardGates.push({
        gate: "build",
        passed: false,
        required: true,
        outputSnippet: "No build evidence provided",
      });
    }
  }

  // Validate per-AC evidence
  const acResults: AcValidationResult[] = [];
  const providedEvidence = input.acEvidence || {};
  let acsWithEvidence = 0;

  for (let i = 0; i < acceptanceCriteria.length; i++) {
    const acId = `AC-${i + 1}`;
    const evidence = providedEvidence[acId];

    if (evidence) {
      acsWithEvidence++;
      acResults.push({
        acId,
        passes: evidence.passes,
        hasEvidence: true,
        evidence: evidence.evidence,
        command: evidence.command,
        outputSnippet: truncateOutput(evidence.output),
        blockedReason: evidence.blockedReason,
      });
    } else {
      // No evidence for this AC
      acResults.push({
        acId,
        passes: false,
        hasEvidence: false,
        blockedReason: "No evidence provided for this AC",
      });
    }
  }

  // If agent claims passes=true but hard gates failed, override to false
  if (input.passes && !hardGatesPassed) {
    evidenceOverride = true;
  }

  // If agent claims passes=true but no AC evidence provided at all, warn but don't override
  // (backward compatibility - evidence is encouraged but not strictly required yet)
  if (input.passes && acceptanceCriteria.length > 0 && acsWithEvidence === 0) {
    // Don't override, but note it in the validation
    if (!overrideReason) {
      overrideReason = "Warning: No AC evidence provided. Consider providing evidence for each AC.";
    }
  }

  return {
    hardGatesPassed,
    hardGates,
    acResults,
    acsWithEvidence,
    totalAcs: acceptanceCriteria.length,
    evidenceOverride,
    overrideReason,
  };
}

/**
 * Convert validation results to AcEvidence format for storage.
 */
function validationToAcEvidence(
  validation: EvidenceValidation,
  inputEvidence: Record<string, { passes: boolean; evidence?: string; command?: string; output?: string; blockedReason?: string }> | undefined
): Record<string, AcEvidence> {
  const result: Record<string, AcEvidence> = {};

  for (const acResult of validation.acResults) {
    const inputAc = inputEvidence?.[acResult.acId];
    result[acResult.acId] = {
      passes: acResult.passes,
      evidence: inputAc?.evidence,
      command: inputAc?.command,
      output: truncateOutput(inputAc?.output, 1000), // Store more in DB than in response
      blockedReason: acResult.blockedReason,
    };
  }

  return result;
}

export async function update(input: UpdateInput): Promise<UpdateResult> {
  // Find execution by branch
  const execution = await findExecutionByBranch(input.branch);

  if (!execution) {
    throw new Error(`No execution found for branch: ${input.branch}`);
  }

  // Find and update the story
  const storyKey = `${execution.id}:${input.storyId}`;
  const story = await findUserStoryById(storyKey);

  if (!story) {
    throw new Error(
      `No story found with ID ${input.storyId} for branch ${input.branch}`
    );
  }

  // Record loop result for stagnation detection
  const filesChanged = input.filesChanged ?? 0;
  const error = input.error ?? null;
  const stagnationResult = await recordLoopResult(execution.id, filesChanged, error);

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
      },
    };
  }

  // US-001: Validate evidence before accepting passes=true
  const evidenceValidation = validateEvidence(input, story.acceptanceCriteria);
  const originalPasses = input.passes;

  // Override passes to false if hard gates failed
  let effectivePasses = input.passes;
  if (input.passes && evidenceValidation.evidenceOverride && !evidenceValidation.hardGatesPassed) {
    effectivePasses = false;
  }

  // Convert validation to storage format
  const acEvidenceForStorage = validationToAcEvidence(evidenceValidation, input.acEvidence);

  // Update story with evidence
  await updateUserStory(storyKey, {
    passes: effectivePasses,
    notes: input.notes || story.notes,
    acEvidence: acEvidenceForStorage,
  });

  // Append to ralph-progress.md if passed
  if (effectivePasses && execution.worktreePath) {
    try {
      const progressPath = join(execution.worktreePath, "ralph-progress.md");
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
  const allStories = await listUserStoriesByExecutionId(execution.id);

  // Check if this update completes all stories
  const updatedStories = allStories.map((s) =>
    s.id === storyKey ? { ...s, passes: effectivePasses } : s
  );
  const allComplete = updatedStories.every((s) => s.passes);
  const completedCount = updatedStories.filter((s) => s.passes).length;

  // Update execution status
  const newStatus = allComplete ? "completed" : "running";
  await updateExecution(execution.id, { status: newStatus, updatedAt: new Date() });

  // Auto add to merge queue if enabled and all complete
  let addedToMergeQueue = false;
  if (allComplete && execution.autoMerge) {
    // Check if already in queue
    const existingInQueue = await findMergeQueueItemByExecutionId(execution.id);

    if (!existingInQueue) {
      const queue = await listMergeQueue();
      const maxPosition = queue.length > 0 ? Math.max(...queue.map((q) => q.position)) : 0;
      const nextPosition = maxPosition + 1;

      await insertMergeQueueItem({
        executionId: execution.id,
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
  if (allComplete && execution.notifyOnComplete) {
    notifier.notify({
      title: "Ralph PRD Complete",
      message: `${execution.branch} - All ${allStories.length} stories done!`,
      sound: true,
    });
  }

  // Trigger dependent executions when this PRD completes
  // Mark dependents as 'ready' so the Runner can pick them up
  const triggeredDependents: Array<{ branch: string; agentPrompt: string | null; blockedReason?: string }> = [];
  if (allComplete) {
    const dependents = await findExecutionsDependingOn(execution.branch);

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

  return {
    success: true,
    branch: input.branch,
    storyId: input.storyId,
    passes: effectivePasses,
    originalPasses: originalPasses !== effectivePasses ? originalPasses : undefined,
    allComplete,
    progress: `${completedCount}/${allStories.length} US`,
    addedToMergeQueue,
    triggeredDependents,
    readyDependents: triggeredDependents, // Same as triggeredDependents, now marked as ready
    evidenceValidation,
  };
}
