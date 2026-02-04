import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export const RALPH_DATA_DIR =
  process.env.RALPH_DATA_DIR?.replace("~", homedir()) ||
  join(homedir(), ".ralph");

const STATE_PATH = join(RALPH_DATA_DIR, "state.json");

/**
 * Maximum number of archived executions to retain.
 * Configurable via RALPH_MAX_ARCHIVED environment variable.
 */
export const MAX_ARCHIVED_EXECUTIONS = parseInt(
  process.env.RALPH_MAX_ARCHIVED || "50",
  10
);

if (!existsSync(RALPH_DATA_DIR)) {
  mkdirSync(RALPH_DATA_DIR, { recursive: true });
}

export type ExecutionStatus =
  | "pending"
  | "ready"      // Dependencies satisfied, waiting for Runner to pick up
  | "starting"   // Runner claimed, Agent launching
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "merging"
  | "merged";    // Final state after successful merge

/**
 * Valid state transitions for ExecutionStatus.
 * Key: current status, Value: array of valid next statuses
 */
export const VALID_TRANSITIONS: Record<ExecutionStatus, ExecutionStatus[]> = {
  pending: ["ready", "running", "stopped", "failed"],           // ready when deps satisfied, running if no deps
  ready: ["starting", "stopped", "failed", "pending"],          // starting when Runner claims, back to pending if deps change
  starting: ["running", "ready", "failed", "stopped"],          // running when Agent starts, ready on launch failure (retry)
  running: ["completed", "failed", "stopped", "merging"],       // normal execution flow
  completed: ["merging"],                                        // only to merging
  failed: ["running", "ready", "stopped"],                       // retry scenarios
  stopped: [],                                                   // terminal state
  merging: ["merged", "failed"],                                 // merge result: merged on success, failed on error
  merged: [],                                                    // terminal state after successful merge
};

/**
 * Check if a status transition is valid.
 */
export function isValidTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export type ConflictStrategy = "auto_theirs" | "auto_ours" | "notify" | "agent";

/**
 * Reason for reconciliation (when execution is archived by reconcile).
 */
export type ReconcileReason = "branch_merged" | "branch_deleted" | "worktree_missing" | null;

/**
 * Recovery log entry for tracking auto-recovery attempts (US-005).
 */
export interface RecoveryEntry {
  timestamp: Date;
  reason: string; // e.g., "process_exit", "stale", "startup_failure"
  attemptNumber: number;
  success: boolean;
  error?: string;
}

/**
 * Get a human-readable error message for invalid transitions.
 */
export function getTransitionError(
  from: ExecutionStatus,
  to: ExecutionStatus
): string {
  const validTargets = VALID_TRANSITIONS[from];
  if (validTargets.length === 0) {
    return `Cannot transition from '${from}' - it is a terminal state`;
  }
  return `Invalid transition from '${from}' to '${to}'. Valid transitions: ${validTargets.join(", ")}`;
}

export interface ExecutionRecord {
  id: string;
  project: string;
  branch: string;
  description: string;
  prdPath: string;
  projectRoot: string;
  worktreePath: string | null;
  status: ExecutionStatus;
  agentTaskId: string | null;
  agentPid: number | null; // Process ID of the agent (US-002)
  onConflict: ConflictStrategy | null;
  autoMerge: boolean;
  notifyOnComplete: boolean;
  dependencies: string[]; // Branch names this execution depends on
  // Stagnation detection fields
  loopCount: number; // Total loop iterations
  consecutiveNoProgress: number; // Loops with no file changes
  consecutiveErrors: number; // Loops with repeated errors
  lastError: string | null; // Last error for comparison
  lastFilesChanged: number; // Files changed in last update
  // Launch recovery fields (US-006)
  launchAttemptAt: Date | null; // Last launch attempt timestamp
  launchAttempts: number; // Number of launch attempts
  // Startup confirmation fields (US-003)
  startupConfirmedAt: Date | null; // When first activity was detected after launch
  // Health monitoring fields (US-001)
  lastActivityAt: Date | null; // Last detected activity (log file update or ralph_update)
  healthStatus: "active" | "idle" | "at_risk" | "stale" | null; // Health status based on activity
  // Auto recovery fields (US-005)
  recoveryCount: number; // Number of auto-recovery attempts
  recoveryLog: RecoveryEntry[]; // History of recovery attempts
  // Merge tracking fields
  mergedAt: Date | null; // Timestamp when successfully merged
  mergeCommitSha: string | null; // Git commit SHA of the merge
  // Reconcile tracking
  reconcileReason: ReconcileReason; // Reason if archived by reconcile
  createdAt: Date;
  updatedAt: Date;
}

export interface AcEvidence {
  passes: boolean;
  evidence?: string;
  command?: string;
  output?: string;
  blockedReason?: string;
}

export interface UserStoryRecord {
  id: string; // `${executionId}:${storyId}`
  executionId: string;
  storyId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  passes: boolean;
  notes: string;
  acEvidence: Record<string, AcEvidence>; // Per-AC evidence mapping
}

export type MergeQueueStatus = "pending" | "merging" | "completed" | "failed";

export interface MergeQueueItem {
  id: number;
  executionId: string;
  position: number;
  status: MergeQueueStatus;
  createdAt: Date;
}

interface StateFileV1 {
  version: 1;
  executions: Array<Omit<ExecutionRecord, "createdAt" | "updatedAt" | "launchAttemptAt" | "lastActivityAt" | "startupConfirmedAt" | "mergedAt" | "recoveryLog"> & { createdAt: string; updatedAt: string; launchAttemptAt: string | null; lastActivityAt: string | null; startupConfirmedAt: string | null; mergedAt: string | null; recoveryLog?: Array<Omit<RecoveryEntry, "timestamp"> & { timestamp: string }> }>;
  userStories: UserStoryRecord[];
  mergeQueue: Array<Omit<MergeQueueItem, "createdAt"> & { createdAt: string }>;
  // Archived data for history
  archivedExecutions?: Array<Omit<ExecutionRecord, "createdAt" | "updatedAt" | "launchAttemptAt" | "lastActivityAt" | "startupConfirmedAt" | "mergedAt" | "recoveryLog"> & { createdAt: string; updatedAt: string; launchAttemptAt: string | null; lastActivityAt: string | null; startupConfirmedAt: string | null; mergedAt: string | null; recoveryLog?: Array<Omit<RecoveryEntry, "timestamp"> & { timestamp: string }> }>;
  archivedUserStories?: UserStoryRecord[];
}

interface StateRuntime {
  executions: ExecutionRecord[];
  userStories: UserStoryRecord[];
  mergeQueue: MergeQueueItem[];
  // Archived data for history
  archivedExecutions: ExecutionRecord[];
  archivedUserStories: UserStoryRecord[];
}

function parseDate(value: string, fieldName: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date in ${fieldName}: ${value}`);
  }
  return date;
}

function toIso(date: Date): string {
  return date.toISOString();
}

function defaultState(): StateRuntime {
  return { executions: [], userStories: [], mergeQueue: [], archivedExecutions: [], archivedUserStories: [] };
}

function normalizeState(raw: unknown): StateFileV1 {
  const base: StateFileV1 = {
    version: 1,
    executions: [],
    userStories: [],
    mergeQueue: [],
    archivedExecutions: [],
    archivedUserStories: [],
  };

  if (!raw || typeof raw !== "object") return base;

  const obj = raw as Record<string, unknown>;
  if (obj.version === 1) base.version = 1;
  if (Array.isArray(obj.executions)) base.executions = obj.executions as StateFileV1["executions"];
  if (Array.isArray(obj.userStories)) base.userStories = obj.userStories as StateFileV1["userStories"];
  if (Array.isArray(obj.mergeQueue)) base.mergeQueue = obj.mergeQueue as StateFileV1["mergeQueue"];
  if (Array.isArray(obj.archivedExecutions)) base.archivedExecutions = obj.archivedExecutions as StateFileV1["archivedExecutions"];
  if (Array.isArray(obj.archivedUserStories)) base.archivedUserStories = obj.archivedUserStories as StateFileV1["archivedUserStories"];
  return base;
}

function deserializeState(file: StateFileV1): StateRuntime {
  const deserializeExecution = (e: StateFileV1["executions"][0]) => ({
    ...e,
    dependencies: Array.isArray(e.dependencies) ? e.dependencies : [],
    // Stagnation detection defaults for backward compatibility
    loopCount: typeof (e as any).loopCount === "number" ? (e as any).loopCount : 0,
    consecutiveNoProgress: typeof (e as any).consecutiveNoProgress === "number" ? (e as any).consecutiveNoProgress : 0,
    consecutiveErrors: typeof (e as any).consecutiveErrors === "number" ? (e as any).consecutiveErrors : 0,
    lastError: typeof (e as any).lastError === "string" ? (e as any).lastError : null,
    lastFilesChanged: typeof (e as any).lastFilesChanged === "number" ? (e as any).lastFilesChanged : 0,
    // Launch recovery defaults for backward compatibility (US-006)
    launchAttemptAt: typeof (e as any).launchAttemptAt === "string" ? parseDate((e as any).launchAttemptAt, "executions.launchAttemptAt") : null,
    launchAttempts: typeof (e as any).launchAttempts === "number" ? (e as any).launchAttempts : 0,
    // Health monitoring defaults for backward compatibility (US-001)
    lastActivityAt: typeof (e as any).lastActivityAt === "string" ? parseDate((e as any).lastActivityAt, "executions.lastActivityAt") : null,
    healthStatus: typeof (e as any).healthStatus === "string" ? (e as any).healthStatus : null,
    // Process liveness defaults for backward compatibility (US-002)
    agentPid: typeof (e as any).agentPid === "number" ? (e as any).agentPid : null,
    // Startup confirmation defaults for backward compatibility (US-003)
    startupConfirmedAt: typeof (e as any).startupConfirmedAt === "string" ? parseDate((e as any).startupConfirmedAt, "executions.startupConfirmedAt") : null,
    // Auto recovery defaults for backward compatibility (US-005)
    recoveryCount: typeof (e as any).recoveryCount === "number" ? (e as any).recoveryCount : 0,
    recoveryLog: Array.isArray((e as any).recoveryLog)
      ? (e as any).recoveryLog.map((entry: any) => ({
          ...entry,
          timestamp: typeof entry.timestamp === "string" ? parseDate(entry.timestamp, "executions.recoveryLog.timestamp") : new Date(),
        }))
      : [],
    // Merge tracking defaults for backward compatibility
    mergedAt: typeof (e as any).mergedAt === "string" ? parseDate((e as any).mergedAt, "executions.mergedAt") : null,
    mergeCommitSha: typeof (e as any).mergeCommitSha === "string" ? (e as any).mergeCommitSha : null,
    // Reconcile tracking defaults for backward compatibility
    reconcileReason: (e as any).reconcileReason || null,
    createdAt: parseDate(e.createdAt, "executions.createdAt"),
    updatedAt: parseDate(e.updatedAt, "executions.updatedAt"),
  });

  const deserializeUserStory = (s: UserStoryRecord) => ({
    ...s,
    acceptanceCriteria: Array.isArray(s.acceptanceCriteria)
      ? s.acceptanceCriteria
      : [],
    notes: typeof s.notes === "string" ? s.notes : "",
    acEvidence: typeof (s as any).acEvidence === "object" && (s as any).acEvidence !== null
      ? (s as any).acEvidence
      : {},
  });

  return {
    executions: file.executions.map(deserializeExecution),
    userStories: file.userStories.map(deserializeUserStory),
    mergeQueue: file.mergeQueue.map((q) => ({
      ...q,
      createdAt: parseDate(q.createdAt, "mergeQueue.createdAt"),
    })),
    archivedExecutions: (file.archivedExecutions || []).map(deserializeExecution),
    archivedUserStories: (file.archivedUserStories || []).map(deserializeUserStory),
  };
}

function serializeState(state: StateRuntime): StateFileV1 {
  const serializeExecution = (e: ExecutionRecord) => ({
    ...e,
    launchAttemptAt: e.launchAttemptAt ? toIso(e.launchAttemptAt) : null,
    lastActivityAt: e.lastActivityAt ? toIso(e.lastActivityAt) : null,
    startupConfirmedAt: e.startupConfirmedAt ? toIso(e.startupConfirmedAt) : null,
    recoveryLog: e.recoveryLog.map((entry) => ({
      ...entry,
      timestamp: toIso(entry.timestamp),
    })),
    mergedAt: e.mergedAt ? toIso(e.mergedAt) : null,
    createdAt: toIso(e.createdAt),
    updatedAt: toIso(e.updatedAt),
  });

  return {
    version: 1,
    executions: state.executions.map(serializeExecution),
    userStories: state.userStories,
    mergeQueue: state.mergeQueue.map((q) => ({
      ...q,
      createdAt: toIso(q.createdAt),
    })),
    archivedExecutions: state.archivedExecutions.map(serializeExecution),
    archivedUserStories: state.archivedUserStories,
  };
}

let lock: Promise<void> = Promise.resolve();

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = lock;
  let release: () => void;
  lock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await fn();
  } finally {
    release!();
  }
}

async function readStateUnlocked(): Promise<StateRuntime> {
  if (!existsSync(STATE_PATH)) return defaultState();
  const rawText = await readFile(STATE_PATH, "utf-8");
  const rawJson = JSON.parse(rawText) as unknown;
  const normalized = normalizeState(rawJson);
  return deserializeState(normalized);
}

async function writeStateUnlocked(state: StateRuntime): Promise<void> {
  const file = serializeState(state);
  await writeFile(STATE_PATH, JSON.stringify(file, null, 2) + "\n", "utf-8");
}

async function mutateState<T>(mutator: (state: StateRuntime) => T | Promise<T>): Promise<T> {
  return withLock(async () => {
    const state = await readStateUnlocked();
    const result = await mutator(state);
    await writeStateUnlocked(state);
    return result;
  });
}

async function readState<T>(reader: (state: StateRuntime) => T | Promise<T>): Promise<T> {
  return withLock(async () => {
    const state = await readStateUnlocked();
    return await reader(state);
  });
}

export async function listExecutions(): Promise<ExecutionRecord[]> {
  return readState((s) => s.executions.slice());
}

export async function findExecutionByBranch(branch: string): Promise<ExecutionRecord | null> {
  return readState((s) => s.executions.find((e) => e.branch === branch) ?? null);
}

export async function findExecutionById(executionId: string): Promise<ExecutionRecord | null> {
  return readState((s) => s.executions.find((e) => e.id === executionId) ?? null);
}

export async function insertExecution(execution: ExecutionRecord): Promise<void> {
  return mutateState((s) => {
    const existing = s.executions.find((e) => e.branch === execution.branch);
    if (existing) {
      throw new Error(`Execution already exists for branch ${execution.branch}`);
    }
    s.executions.push(execution);
  });
}

export async function updateExecution(
  executionId: string,
  patch: Partial<Omit<ExecutionRecord, "id" | "createdAt">> & { updatedAt?: Date },
  options?: { skipTransitionValidation?: boolean }
): Promise<void> {
  return mutateState((s) => {
    const exec = s.executions.find((e) => e.id === executionId);
    if (!exec) throw new Error(`No execution found with id: ${executionId}`);

    // Validate state transition if status is being changed
    if (patch.status && patch.status !== exec.status && !options?.skipTransitionValidation) {
      if (!isValidTransition(exec.status, patch.status)) {
        throw new Error(getTransitionError(exec.status, patch.status));
      }
    }

    Object.assign(exec, patch);
  });
}

export async function deleteExecution(executionId: string): Promise<void> {
  return mutateState((s) => {
    s.executions = s.executions.filter((e) => e.id !== executionId);
    s.userStories = s.userStories.filter((st) => st.executionId !== executionId);
    s.mergeQueue = s.mergeQueue.filter((q) => q.executionId !== executionId);
  });
}

export async function listUserStoriesByExecutionId(executionId: string): Promise<UserStoryRecord[]> {
  return readState((s) => s.userStories.filter((st) => st.executionId === executionId));
}

export async function findUserStoryById(storyKey: string): Promise<UserStoryRecord | null> {
  return readState((s) => s.userStories.find((st) => st.id === storyKey) ?? null);
}

export async function insertUserStories(stories: UserStoryRecord[]): Promise<void> {
  return mutateState((s) => {
    for (const story of stories) {
      const existingIndex = s.userStories.findIndex((st) => st.id === story.id);
      if (existingIndex >= 0) s.userStories.splice(existingIndex, 1);
      s.userStories.push(story);
    }
  });
}

export async function updateUserStory(
  storyKey: string,
  patch: Partial<Omit<UserStoryRecord, "id" | "executionId" | "storyId">>
): Promise<void> {
  return mutateState((s) => {
    const story = s.userStories.find((st) => st.id === storyKey);
    if (!story) throw new Error(`No story found with id: ${storyKey}`);
    Object.assign(story, patch);
  });
}

export async function listMergeQueue(): Promise<MergeQueueItem[]> {
  return readState((s) =>
    s.mergeQueue
      .slice()
      .sort((a, b) => a.position - b.position || a.id - b.id)
  );
}

export async function findMergeQueueItemByExecutionId(executionId: string): Promise<MergeQueueItem | null> {
  return readState((s) => s.mergeQueue.find((q) => q.executionId === executionId) ?? null);
}

export async function insertMergeQueueItem(
  item: Omit<MergeQueueItem, "id">
): Promise<MergeQueueItem> {
  return mutateState((s) => {
    const nextId =
      s.mergeQueue.reduce((maxId, q) => Math.max(maxId, q.id), 0) + 1;
    const created: MergeQueueItem = { ...item, id: nextId };
    s.mergeQueue.push(created);
    return created;
  });
}

export async function updateMergeQueueItem(
  id: number,
  patch: Partial<Omit<MergeQueueItem, "id" | "executionId" | "createdAt">>
): Promise<void> {
  return mutateState((s) => {
    const item = s.mergeQueue.find((q) => q.id === id);
    if (!item) throw new Error(`No merge queue item found with id: ${id}`);
    Object.assign(item, patch);
  });
}

export async function deleteMergeQueueByExecutionId(executionId: string): Promise<void> {
  return mutateState((s) => {
    s.mergeQueue = s.mergeQueue.filter((q) => q.executionId !== executionId);
  });
}

/**
 * Find all executions that depend on a given branch.
 */
export async function findExecutionsDependingOn(branch: string): Promise<ExecutionRecord[]> {
  return readState((s) =>
    s.executions.filter((e) => e.dependencies.includes(branch))
  );
}

/**
 * Check if all dependencies of an execution are completed.
 */
export async function areDependenciesSatisfied(execution: ExecutionRecord): Promise<{
  satisfied: boolean;
  pending: string[];
  completed: string[];
}> {
  if (!execution.dependencies || execution.dependencies.length === 0) {
    return { satisfied: true, pending: [], completed: [] };
  }

  return readState((s) => {
    const pending: string[] = [];
    const completed: string[] = [];

    for (const depBranch of execution.dependencies) {
      const depExec = s.executions.find((e) => e.branch === depBranch);
      if (depExec && depExec.status === "completed") {
        completed.push(depBranch);
      } else {
        pending.push(depBranch);
      }
    }

    return {
      satisfied: pending.length === 0,
      pending,
      completed,
    };
  });
}

// =============================================================================
// STAGNATION DETECTION
// =============================================================================

/**
 * Stagnation detection thresholds (matching original ralph-claude-code)
 */
export const STAGNATION_THRESHOLDS = {
  NO_PROGRESS_THRESHOLD: 3, // Open circuit after 3 loops with no file changes
  SAME_ERROR_THRESHOLD: 5, // Open circuit after 5 loops with repeated errors
  MAX_LOOPS_PER_STORY: 10, // Safety limit per story
};

export type StagnationType = "no_progress" | "repeated_error" | "max_loops" | null;

export interface StagnationCheckResult {
  isStagnant: boolean;
  type: StagnationType;
  message: string;
  metrics: {
    loopCount: number;
    consecutiveNoProgress: number;
    consecutiveErrors: number;
    lastError: string | null;
  };
}

/**
 * Check if an execution is stagnant (stuck in a loop).
 */
export async function checkStagnation(executionId: string): Promise<StagnationCheckResult> {
  return readState((s) => {
    const exec = s.executions.find((e) => e.id === executionId);
    if (!exec) {
      return {
        isStagnant: false,
        type: null,
        message: "Execution not found",
        metrics: { loopCount: 0, consecutiveNoProgress: 0, consecutiveErrors: 0, lastError: null },
      };
    }

    const metrics = {
      loopCount: exec.loopCount,
      consecutiveNoProgress: exec.consecutiveNoProgress,
      consecutiveErrors: exec.consecutiveErrors,
      lastError: exec.lastError,
    };

    // Check no progress threshold
    if (exec.consecutiveNoProgress >= STAGNATION_THRESHOLDS.NO_PROGRESS_THRESHOLD) {
      return {
        isStagnant: true,
        type: "no_progress",
        message: `No file changes for ${exec.consecutiveNoProgress} consecutive loops (threshold: ${STAGNATION_THRESHOLDS.NO_PROGRESS_THRESHOLD})`,
        metrics,
      };
    }

    // Check repeated error threshold
    if (exec.consecutiveErrors >= STAGNATION_THRESHOLDS.SAME_ERROR_THRESHOLD) {
      return {
        isStagnant: true,
        type: "repeated_error",
        message: `Same error repeated ${exec.consecutiveErrors} times (threshold: ${STAGNATION_THRESHOLDS.SAME_ERROR_THRESHOLD}): ${exec.lastError?.slice(0, 100)}`,
        metrics,
      };
    }

    // Check max loops per story
    const stories = s.userStories.filter((st) => st.executionId === executionId);
    const pendingStories = stories.filter((st) => !st.passes);
    if (pendingStories.length > 0 && exec.loopCount >= STAGNATION_THRESHOLDS.MAX_LOOPS_PER_STORY * pendingStories.length) {
      return {
        isStagnant: true,
        type: "max_loops",
        message: `Exceeded max loops (${exec.loopCount}) for ${pendingStories.length} pending stories`,
        metrics,
      };
    }

    return {
      isStagnant: false,
      type: null,
      message: "OK",
      metrics,
    };
  });
}

/**
 * Record a loop result for stagnation tracking.
 */
export async function recordLoopResult(
  executionId: string,
  filesChanged: number,
  error: string | null
): Promise<StagnationCheckResult> {
  return mutateState(async (s) => {
    const exec = s.executions.find((e) => e.id === executionId);
    if (!exec) {
      throw new Error(`No execution found with id: ${executionId}`);
    }

    // Increment loop count
    exec.loopCount++;
    exec.lastFilesChanged = filesChanged;
    exec.updatedAt = new Date();

    // Track no progress
    if (filesChanged === 0) {
      exec.consecutiveNoProgress++;
    } else {
      exec.consecutiveNoProgress = 0;
    }

    // Track repeated errors
    if (error) {
      if (exec.lastError === error) {
        exec.consecutiveErrors++;
      } else {
        exec.consecutiveErrors = 1;
        exec.lastError = error;
      }
    } else {
      exec.consecutiveErrors = 0;
      exec.lastError = null;
    }

    // Check stagnation after recording
    const metrics = {
      loopCount: exec.loopCount,
      consecutiveNoProgress: exec.consecutiveNoProgress,
      consecutiveErrors: exec.consecutiveErrors,
      lastError: exec.lastError,
    };

    if (exec.consecutiveNoProgress >= STAGNATION_THRESHOLDS.NO_PROGRESS_THRESHOLD) {
      exec.status = "failed";
      return {
        isStagnant: true,
        type: "no_progress" as StagnationType,
        message: `Stagnation detected: No file changes for ${exec.consecutiveNoProgress} consecutive loops`,
        metrics,
      };
    }

    if (exec.consecutiveErrors >= STAGNATION_THRESHOLDS.SAME_ERROR_THRESHOLD) {
      exec.status = "failed";
      return {
        isStagnant: true,
        type: "repeated_error" as StagnationType,
        message: `Stagnation detected: Same error repeated ${exec.consecutiveErrors} times`,
        metrics,
      };
    }

    return {
      isStagnant: false,
      type: null,
      message: "OK",
      metrics,
    };
  });
}

/**
 * Reset stagnation counters (e.g., after manual intervention).
 */
export async function resetStagnation(executionId: string): Promise<void> {
  return mutateState((s) => {
    const exec = s.executions.find((e) => e.id === executionId);
    if (!exec) throw new Error(`No execution found with id: ${executionId}`);
    exec.consecutiveNoProgress = 0;
    exec.consecutiveErrors = 0;
    exec.lastError = null;
    exec.updatedAt = new Date();
  });
}

// =============================================================================
// ARCHIVE MANAGEMENT
// =============================================================================

/**
 * Archive an execution and its associated user stories.
 * Moves the execution from active to archived state.
 * Also cleans up any merge queue entries for this execution.
 * Enforces retention policy by removing oldest archives when limit is exceeded.
 */
export async function archiveExecution(executionId: string): Promise<void> {
  return mutateState((s) => {
    const execIndex = s.executions.findIndex((e) => e.id === executionId);
    if (execIndex === -1) {
      throw new Error(`No execution found with id: ${executionId}`);
    }

    // Remove execution from active list and add to archive
    const [exec] = s.executions.splice(execIndex, 1);
    s.archivedExecutions.push(exec);

    // Move associated user stories to archive
    const storiesToArchive = s.userStories.filter((st) => st.executionId === executionId);
    s.userStories = s.userStories.filter((st) => st.executionId !== executionId);
    s.archivedUserStories.push(...storiesToArchive);

    // Clean up merge queue entries
    s.mergeQueue = s.mergeQueue.filter((q) => q.executionId !== executionId);

    // Enforce retention policy: remove oldest archives if limit exceeded
    if (s.archivedExecutions.length > MAX_ARCHIVED_EXECUTIONS) {
      // Sort by mergedAt (or updatedAt as fallback), oldest first
      s.archivedExecutions.sort((a, b) => {
        const aTime = (a.mergedAt || a.updatedAt).getTime();
        const bTime = (b.mergedAt || b.updatedAt).getTime();
        return aTime - bTime;
      });

      // Calculate how many to remove
      const toRemove = s.archivedExecutions.length - MAX_ARCHIVED_EXECUTIONS;
      const removedExecutions = s.archivedExecutions.splice(0, toRemove);

      // Remove associated user stories for deleted archives
      const removedIds = new Set(removedExecutions.map((e) => e.id));
      s.archivedUserStories = s.archivedUserStories.filter(
        (st) => !removedIds.has(st.executionId)
      );
    }
  });
}

/**
 * List all archived executions.
 */
export async function listArchivedExecutions(): Promise<ExecutionRecord[]> {
  return readState((s) => s.archivedExecutions.slice());
}

/**
 * List archived user stories by execution ID.
 */
export async function listArchivedUserStoriesByExecutionId(executionId: string): Promise<UserStoryRecord[]> {
  return readState((s) => s.archivedUserStories.filter((st) => st.executionId === executionId));
}

/**
 * Find an archived execution by ID.
 */
export async function findArchivedExecutionById(executionId: string): Promise<ExecutionRecord | null> {
  return readState((s) => s.archivedExecutions.find((e) => e.id === executionId) ?? null);
}

/**
 * Find an archived execution by branch name.
 */
export async function findArchivedExecutionByBranch(branch: string): Promise<ExecutionRecord | null> {
  return readState((s) => s.archivedExecutions.find((e) => e.branch === branch) ?? null);
}
