import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync, type Dirent } from "fs";
import { readFile, readdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, isAbsolute, join } from "path";
import * as lockfile from "proper-lockfile";
import matter from "gray-matter";
import { generateBranchName } from "../utils/prd-parser.js";

export const RALPH_DATA_DIR =
  process.env.RALPH_DATA_DIR?.replace("~", homedir()) ||
  join(homedir(), ".ralph");

const STATE_PATH = join(RALPH_DATA_DIR, "state.json");
const STATE_LOCK_PATH = join(RALPH_DATA_DIR, "state.lock");

export const DEFAULT_MAX_CONCURRENCY = 3;

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
  | "interrupted" // Session closed or agent crashed, can auto-retry
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
  running: ["completed", "failed", "stopped", "merging", "interrupted"], // normal execution flow + interrupt detection
  interrupted: ["ready", "failed"],                              // ready for auto-retry, failed if max retries exceeded
  completed: ["merging"],                                        // only to merging
  failed: ["running", "ready", "stopped"],                       // retry scenarios
  stopped: ["ready"],                                           // can be retried via ralph_retry
  merging: ["merged", "failed"],                                 // merge result: merged on success, failed on error
  merged: [],                                                    // terminal state after successful merge
};

/**
 * Check if a status transition is valid.
 */
export function isValidTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * PRD-level priority for scheduling.
 * - P0: highest priority
 * - P1: default
 * - P2: lowest priority
 */
export type ExecutionPriority = "P0" | "P1" | "P2";

export const DEFAULT_EXECUTION_PRIORITY: ExecutionPriority = "P1";

export function normalizeExecutionPriority(value: unknown): ExecutionPriority {
  if (typeof value !== "string") return DEFAULT_EXECUTION_PRIORITY;
  const normalized = value.trim().toUpperCase();
  if (normalized === "P0" || normalized === "P1" || normalized === "P2") {
    return normalized;
  }
  return DEFAULT_EXECUTION_PRIORITY;
}

export type ConflictStrategy = "auto_theirs" | "auto_ours" | "notify" | "agent";

/**
 * Reason for reconciliation (when execution is archived by reconcile).
 */
export type ReconcileReason = "branch_merged" | "branch_deleted" | "worktree_missing" | null;

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
  priority: ExecutionPriority;
  prdPath: string;
  projectRoot: string;
  worktreePath: string | null;
  /**
   * Branch HEAD commit SHA at the time the execution was created.
   * Used to distinguish "already merged because it never diverged" from a real merge.
   */
  baseCommitSha: string | null;
  status: ExecutionStatus;
  agentTaskId: string | null;
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
  lastProgressAt: Date | null; // Last observed progress timestamp (git/log/files)
  // Current activity tracking
  currentStoryId: string | null; // Story currently being worked on
  currentStep: string | null; // Current step description (e.g., "implementing", "testing")
  stepStartedAt: Date | null; // When current step started
  logPath: string | null; // Path to agent log file for activity monitoring
  // Launch recovery fields (US-006)
  launchAttemptAt: Date | null; // Last launch attempt timestamp
  launchAttempts: number; // Number of launch attempts
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

export interface RunnerConfigRecord {
  maxConcurrency: number;
  updatedAt: Date;
  reason: string | null;
}

interface RunnerConfigFileV1 {
  maxConcurrency: number;
  updatedAt: string;
  reason?: string;
}

interface StateFileV1 {
  version: 1;
  executions: Array<Omit<ExecutionRecord, "createdAt" | "updatedAt" | "launchAttemptAt" | "mergedAt" | "stepStartedAt" | "lastProgressAt"> & { createdAt: string; updatedAt: string; launchAttemptAt: string | null; mergedAt: string | null; stepStartedAt: string | null; lastProgressAt: string | null }>;
  userStories: UserStoryRecord[];
  mergeQueue: Array<Omit<MergeQueueItem, "createdAt"> & { createdAt: string }>;
  // Archived data for history
  archivedExecutions?: Array<Omit<ExecutionRecord, "createdAt" | "updatedAt" | "launchAttemptAt" | "mergedAt" | "stepStartedAt" | "lastProgressAt"> & { createdAt: string; updatedAt: string; launchAttemptAt: string | null; mergedAt: string | null; stepStartedAt: string | null; lastProgressAt: string | null }>;
  archivedUserStories?: UserStoryRecord[];
  runnerConfig?: RunnerConfigFileV1;
}

interface StateRuntime {
  executions: ExecutionRecord[];
  userStories: UserStoryRecord[];
  mergeQueue: MergeQueueItem[];
  // Archived data for history
  archivedExecutions: ExecutionRecord[];
  archivedUserStories: UserStoryRecord[];
  runnerConfig: RunnerConfigRecord | null;
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

function clampMaxConcurrency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_CONCURRENCY;
  return Math.min(10, Math.max(1, Math.round(value)));
}

function defaultState(): StateRuntime {
  return {
    executions: [],
    userStories: [],
    mergeQueue: [],
    archivedExecutions: [],
    archivedUserStories: [],
    runnerConfig: null,
  };
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
  if (typeof obj.runnerConfig === "object" && obj.runnerConfig !== null) base.runnerConfig = obj.runnerConfig as StateFileV1["runnerConfig"];
  return base;
}

function deserializeState(file: StateFileV1): StateRuntime {
  const deserializeRunnerConfig = (raw: RunnerConfigFileV1 | undefined): RunnerConfigRecord | null => {
    if (!raw || typeof raw !== "object") return null;

    const maxConcurrencyRaw = (raw as any).maxConcurrency;
    const maxConcurrency =
      typeof maxConcurrencyRaw === "number"
        ? clampMaxConcurrency(maxConcurrencyRaw)
        : DEFAULT_MAX_CONCURRENCY;

    const updatedAt =
      typeof (raw as any).updatedAt === "string"
        ? parseDate((raw as any).updatedAt, "runnerConfig.updatedAt")
        : new Date(0);

    const reason = typeof (raw as any).reason === "string" ? (raw as any).reason : null;

    return {
      maxConcurrency,
      updatedAt,
      reason,
    };
  };

  const deserializeExecution = (e: StateFileV1["executions"][0]) => ({
    ...e,
    // PRD priority default for backward compatibility
    priority: normalizeExecutionPriority((e as any).priority),
    dependencies: Array.isArray(e.dependencies) ? e.dependencies : [],
    baseCommitSha: typeof (e as any).baseCommitSha === "string" ? (e as any).baseCommitSha : null,
    // Stagnation detection defaults for backward compatibility
    loopCount: typeof (e as any).loopCount === "number" ? (e as any).loopCount : 0,
    consecutiveNoProgress: typeof (e as any).consecutiveNoProgress === "number" ? (e as any).consecutiveNoProgress : 0,
    consecutiveErrors: typeof (e as any).consecutiveErrors === "number" ? (e as any).consecutiveErrors : 0,
    lastError: typeof (e as any).lastError === "string" ? (e as any).lastError : null,
    lastFilesChanged: typeof (e as any).lastFilesChanged === "number" ? (e as any).lastFilesChanged : 0,
    lastProgressAt: typeof (e as any).lastProgressAt === "string" ? parseDate((e as any).lastProgressAt, "executions.lastProgressAt") : null,
    // Current activity tracking defaults for backward compatibility
    currentStoryId: typeof (e as any).currentStoryId === "string" ? (e as any).currentStoryId : null,
    currentStep: typeof (e as any).currentStep === "string" ? (e as any).currentStep : null,
    stepStartedAt: typeof (e as any).stepStartedAt === "string" ? parseDate((e as any).stepStartedAt, "executions.stepStartedAt") : null,
    logPath: typeof (e as any).logPath === "string" ? (e as any).logPath : null,
    // Launch recovery defaults for backward compatibility (US-006)
    launchAttemptAt: typeof (e as any).launchAttemptAt === "string" ? parseDate((e as any).launchAttemptAt, "executions.launchAttemptAt") : null,
    launchAttempts: typeof (e as any).launchAttempts === "number" ? (e as any).launchAttempts : 0,
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
    runnerConfig: deserializeRunnerConfig(file.runnerConfig),
  };
}

function serializeState(state: StateRuntime): StateFileV1 {
  const serializeExecution = (e: ExecutionRecord) => ({
    ...e,
    stepStartedAt: e.stepStartedAt ? toIso(e.stepStartedAt) : null,
    lastProgressAt: e.lastProgressAt ? toIso(e.lastProgressAt) : null,
    launchAttemptAt: e.launchAttemptAt ? toIso(e.launchAttemptAt) : null,
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
    runnerConfig: state.runnerConfig
      ? {
          maxConcurrency: state.runnerConfig.maxConcurrency,
          updatedAt: toIso(state.runnerConfig.updatedAt),
          reason: state.runnerConfig.reason || undefined,
        }
      : undefined,
  };
}

let lock: Promise<void> = Promise.resolve();

function ensureLockFileExists(): void {
  if (existsSync(STATE_LOCK_PATH)) return;
  try {
    writeFileSync(STATE_LOCK_PATH, "", "utf-8");
  } catch {
    // Ignore - lock acquisition will fail with a clear error
  }
}

async function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
  ensureLockFileExists();
  const release = await lockfile.lock(STATE_LOCK_PATH, {
    retries: { retries: 8, factor: 2, minTimeout: 50, maxTimeout: 2000 },
    stale: 30000, // Consider lock stale after 30 seconds
  });

  try {
    return await fn();
  } finally {
    try {
      await release();
    } catch {
      // Ignore unlock errors
    }
  }
}

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
  const content = JSON.stringify(file, null, 2) + "\n";

  // Validate JSON before writing
  try {
    JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid JSON generated: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Backup current state.json (if it's valid JSON) before overwriting.
  // Backup failures must not block the write.
  const maxBackups = 5;
  try {
    if (existsSync(STATE_PATH)) {
      const existingText = await readFile(STATE_PATH, "utf-8");
      try {
        JSON.parse(existingText);
        const backupPath = join(RALPH_DATA_DIR, `state.json.backup-${Date.now()}`);
        await writeFile(backupPath, existingText, "utf-8");
      } catch {
        // Existing state.json is corrupted/truncated; skip backup.
      }
    }
  } catch {
    // Ignore backup errors.
  }

  const tempPath = STATE_PATH + ".tmp";
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      // Atomic write: write to temp file, then rename
      await writeFile(tempPath, content, "utf-8");
      renameSync(tempPath, STATE_PATH);

      // Cleanup old backups; failures must not block a successful write.
      try {
        const entries = await readdir(RALPH_DATA_DIR, { withFileTypes: true });
        const backups = entries
          .filter((e) => e.isFile() && e.name.startsWith("state.json.backup-"))
          .map((e) => e.name)
          .sort()
          .reverse();

        for (const backupName of backups.slice(maxBackups)) {
          try {
            unlinkSync(join(RALPH_DATA_DIR, backupName));
          } catch {
            // Ignore cleanup errors.
          }
        }
      } catch {
        // Ignore cleanup errors.
      }
      return;
    } catch (err) {
      // Clean up temp file on failure
      try { unlinkSync(tempPath); } catch {}

      const code = (err as NodeJS.ErrnoException)?.code;
      const retryable = code === "EBUSY" || code === "EPERM";
      if (!retryable || attempt === 5) throw err;

      const delayMs = Math.min(2000, 50 * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function mutateState<T>(mutator: (state: StateRuntime) => T | Promise<T>): Promise<T> {
  return withLock(async () => {
    return withFileLock(async () => {
      const state = await readStateUnlocked();
      const result = await mutator(state);
      await writeStateUnlocked(state);
      return result;
    });
  });
}

async function readState<T>(reader: (state: StateRuntime) => T | Promise<T>): Promise<T> {
  return withLock(async () => {
    return withFileLock(async () => {
      const state = await readStateUnlocked();
      return await reader(state);
    });
  });
}

export async function getRunnerConfig(): Promise<RunnerConfigRecord> {
  return readState((s) => {
    if (s.runnerConfig) return s.runnerConfig;
    return {
      maxConcurrency: DEFAULT_MAX_CONCURRENCY,
      updatedAt: new Date(0),
      reason: null,
    };
  });
}

export async function ensureRunnerConfigInitialized(
  defaultMaxConcurrency: number = DEFAULT_MAX_CONCURRENCY
): Promise<RunnerConfigRecord> {
  return mutateState((s) => {
    if (s.runnerConfig) return s.runnerConfig;

    s.runnerConfig = {
      maxConcurrency: clampMaxConcurrency(defaultMaxConcurrency),
      updatedAt: new Date(),
      reason: null,
    };

    return s.runnerConfig;
  });
}

export async function setRunnerMaxConcurrency(
  maxConcurrency: number,
  reason?: string
): Promise<RunnerConfigRecord> {
  return mutateState((s) => {
    s.runnerConfig = {
      maxConcurrency: clampMaxConcurrency(maxConcurrency),
      updatedAt: new Date(),
      reason: reason || null,
    };

    return s.runnerConfig;
  });
}

export async function listExecutions(): Promise<ExecutionRecord[]> {
  return readState((s) => s.executions.slice());
}

export interface ClaimReadyExecutionResult {
  success: boolean;
  branch: string;
  execution?: ExecutionRecord;
  error?: string;
  globalActive?: number;
  maxConcurrency?: number;
}

/**
 * Atomically claim a `ready` execution for launch by transitioning it to `starting`.
 *
 * This is the only safe way to claim work across multiple Runner processes because it:
 * - validates the current status inside the same file lock (true CAS)
 * - enforces the global `runnerConfig.maxConcurrency` limit
 */
export async function claimReadyExecution(branch: string): Promise<ClaimReadyExecutionResult> {
  const now = new Date();
  return mutateState((s) => {
    const exec = s.executions.find((e) => e.branch === branch);
    if (!exec) {
      return {
        success: false,
        branch,
        error: `No execution found for branch: ${branch}`,
      };
    }

    if (exec.status !== "ready") {
      return {
        success: false,
        branch,
        error: `Cannot claim: status is '${exec.status}', expected 'ready'`,
      };
    }

    const maxConcurrency = s.runnerConfig?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    const globalActive = s.executions.filter(
      (e) => e.status === "running" || e.status === "starting"
    ).length;

    if (globalActive >= maxConcurrency) {
      return {
        success: false,
        branch,
        error: `Global concurrency limit reached (${globalActive}/${maxConcurrency})`,
        globalActive,
        maxConcurrency,
      };
    }

    exec.status = "starting";
    exec.launchAttemptAt = now;
    exec.launchAttempts = (exec.launchAttempts ?? 0) + 1;
    exec.updatedAt = now;

    return {
      success: true,
      branch,
      execution: exec,
      globalActive: globalActive + 1,
      maxConcurrency,
    };
  });
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

/**
 * Atomically insert an execution and its user stories in a single state write.
 * Prevents partially-initialized executions (e.g. missing required fields) from
 * being observed by other readers between writes.
 */
export async function insertExecutionAtomic(
  execution: ExecutionRecord,
  stories: UserStoryRecord[]
): Promise<void> {
  return mutateState((s) => {
    const existing = s.executions.find((e) => e.branch === execution.branch);
    if (existing) {
      throw new Error(`Execution already exists for branch ${execution.branch}`);
    }

    s.executions.push(execution);

    for (const story of stories) {
      const existingIndex = s.userStories.findIndex((st) => st.id === story.id);
      if (existingIndex >= 0) s.userStories.splice(existingIndex, 1);
      s.userStories.push(story);
    }
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
 * Checks both active executions (status: "completed") and archived executions (status: "merged").
 */
export async function areDependenciesSatisfied(execution: Pick<ExecutionRecord, "dependencies" | "projectRoot" | "prdPath">): Promise<{
  satisfied: boolean;
  pending: string[];
  completed: string[];
}> {
  type DependencyPrdMetadata = {
    frontmatter: Record<string, unknown>;
    title: string | null;
  };

  const normalizeDependencySlug = (dep: string): string | null => {
    const slug = dep
      .trim()
      .replace(/\.md$/i, "")
      .replace(/\.json$/i, "")
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .pop();

    return slug ? slug : null;
  };

  const inferBranchPrefix = (ref: string): string => {
    const normalized = ref.trim().replace(/\\/g, "/");
    const idx = normalized.lastIndexOf("/");
    if (idx === -1) return "ralph/";
    return normalized.slice(0, idx + 1);
  };

  const normalizeBranchRef = (ref: string, branchPrefix: string): string => {
    const normalized = ref.trim().replace(/\.md$/i, "").replace(/\.json$/i, "").replace(/\\/g, "/");
    if (!normalized) return "";
    if (normalized.includes("/")) return normalized;
    return `${branchPrefix}${normalized}`;
  };

  const loadPrdMetadata = async (filePath: string): Promise<DependencyPrdMetadata | null> => {
    try {
      const raw = await readFile(filePath, "utf-8");

      if (filePath.toLowerCase().endsWith(".json")) {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object") return null;
        const frontmatter = parsed as Record<string, unknown>;
        const title = typeof frontmatter.title === "string" ? frontmatter.title : null;
        return { frontmatter, title };
      }

      const parsed = matter(raw);
      const frontmatter = parsed.data as Record<string, unknown>;
      const titleMatch = parsed.content.match(/^#\s+(.+)$/m);
      const title =
        (typeof frontmatter.title === "string" ? frontmatter.title : null) ||
        titleMatch?.[1] ||
        null;

      return { frontmatter, title };
    } catch {
      return null;
    }
  };

  const resolveDependencyPrdMetadata = async (
    depSlug: string,
    baseDirs: string[]
  ): Promise<DependencyPrdMetadata | null> => {
    // Fast path: dependency slug matches filename.
    for (const dir of baseDirs) {
      const mdPath = join(dir, `${depSlug}.md`);
      if (existsSync(mdPath)) return loadPrdMetadata(mdPath);

      const jsonPath = join(dir, `${depSlug}.json`);
      if (existsSync(jsonPath)) return loadPrdMetadata(jsonPath);
    }

    // Fallback: scan PRD files for matching `id`/`aliases`/`branch` values.
    const target = depSlug.toLowerCase();

    const matchesTarget = (value: unknown): boolean => {
      if (typeof value !== "string") return false;
      const normalized = normalizeDependencySlug(value);
      return normalized ? normalized.toLowerCase() === target : false;
    };

    for (const dir of baseDirs) {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const lower = entry.name.toLowerCase();
        if (!lower.endsWith(".md") && !lower.endsWith(".json")) continue;
        if (!lower.startsWith("prd-")) continue;

        const meta = await loadPrdMetadata(join(dir, entry.name));
        if (!meta) continue;

        const frontmatter = meta.frontmatter as {
          id?: unknown;
          slug?: unknown;
          aliases?: unknown;
          branch?: unknown;
          branchName?: unknown;
        };

        if (matchesTarget(frontmatter.id)) return meta;
        if (matchesTarget(frontmatter.slug)) return meta;
        if (matchesTarget(frontmatter.branch)) return meta;
        if (matchesTarget(frontmatter.branchName)) return meta;

        if (Array.isArray(frontmatter.aliases) && frontmatter.aliases.some(matchesTarget)) {
          return meta;
        }
      }
    }

    return null;
  };

  if (!execution.dependencies || execution.dependencies.length === 0) {
    return { satisfied: true, pending: [], completed: [] };
  }

  const completed: string[] = [];
  const pending: string[] = [];

  const baseDirs: string[] = [];
  if (execution.prdPath) {
    const prdPath =
      execution.projectRoot && !isAbsolute(execution.prdPath)
        ? join(execution.projectRoot, execution.prdPath)
        : execution.prdPath;
    baseDirs.push(dirname(prdPath));
  }
  if (execution.projectRoot) {
    baseDirs.push(join(execution.projectRoot, "tasks"));
  }

  const remaining: Array<{ dep: string; stateBranches: string[] }> = [];

  for (const depBranch of execution.dependencies) {
    const prdSlug = normalizeDependencySlug(depBranch);
    const branchPrefix = inferBranchPrefix(depBranch);

    const depMeta = prdSlug ? await resolveDependencyPrdMetadata(prdSlug, baseDirs) : null;
    const depFrontmatter = depMeta?.frontmatter ?? null;

    const statusValue = typeof depFrontmatter?.status === "string" ? depFrontmatter.status.trim().toLowerCase() : null;
    if (statusValue === "completed" || statusValue === "merged") {
      completed.push(depBranch);
      continue;
    }

    const branchFromFrontmatter =
      typeof depFrontmatter?.branch === "string" ? depFrontmatter.branch.trim() : "";
    const branchNameFromFrontmatter =
      typeof (depFrontmatter as { branchName?: unknown } | null)?.branchName === "string"
        ? (depFrontmatter as { branchName: string }).branchName.trim()
        : "";

    const stateBranches = new Set<string>();

    const normalizedBranchFromFrontmatter = branchFromFrontmatter
      ? normalizeBranchRef(branchFromFrontmatter, branchPrefix)
      : "";
    const normalizedBranchNameFromFrontmatter = branchNameFromFrontmatter
      ? normalizeBranchRef(branchNameFromFrontmatter, branchPrefix)
      : "";

    if (normalizedBranchFromFrontmatter) stateBranches.add(normalizedBranchFromFrontmatter);
    if (normalizedBranchNameFromFrontmatter) stateBranches.add(normalizedBranchNameFromFrontmatter);

    // Always consider the literal dependency branch for backward-compatibility.
    stateBranches.add(depBranch);

    // If we resolved a PRD file by `id`/`aliases`, also consider the generated branch from its title.
    if (depMeta?.title) {
      stateBranches.add(generateBranchName(depMeta.title, branchPrefix));
    }

    remaining.push({ dep: depBranch, stateBranches: [...stateBranches].filter(Boolean) });
  }

  if (remaining.length === 0) {
    return { satisfied: true, pending: [], completed };
  }

  return readState((s) => {
    const isSatisfiedStatus = (status: ExecutionStatus): boolean =>
      status === "completed" || status === "merged";

    for (const { dep, stateBranches } of remaining) {
      const satisfiedActive = s.executions.some(
        (e) => stateBranches.includes(e.branch) && isSatisfiedStatus(e.status)
      );
      if (satisfiedActive) {
        completed.push(dep);
        continue;
      }

      const satisfiedArchived = s.archivedExecutions.some(
        (e) => stateBranches.includes(e.branch) && isSatisfiedStatus(e.status)
      );
      if (satisfiedArchived) {
        completed.push(dep);
        continue;
      }

      pending.push(dep);
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

export interface RecordLoopProgressSignals {
  gitHeadCommitMs?: number | null;
  changedFilesMaxMtimeMs?: number | null;
  logMtimeMs?: number | null;
}

export interface RecordLoopOptions {
  now?: Date;
  thresholds?: Partial<{
    noProgressThreshold: number;
    sameErrorThreshold: number;
  }>;
  /**
   * When provided, "no progress" only becomes stagnant once BOTH:
   * - consecutiveNoProgress >= noProgressThreshold
   * - (now - lastProgressAt) >= noProgressTimeoutMs
   *
   * If omitted, legacy behavior applies (fail purely by loop threshold).
   */
  noProgressTimeoutMs?: number;
  progressSignals?: RecordLoopProgressSignals;
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
  error: string | null,
  options?: RecordLoopOptions
): Promise<StagnationCheckResult> {
  return mutateState(async (s) => {
    const exec = s.executions.find((e) => e.id === executionId);
    if (!exec) {
      throw new Error(`No execution found with id: ${executionId}`);
    }

    const now = options?.now ?? new Date();
    const nowMs = now.getTime();
    const noProgressThreshold =
      options?.thresholds?.noProgressThreshold ?? STAGNATION_THRESHOLDS.NO_PROGRESS_THRESHOLD;
    const sameErrorThreshold =
      options?.thresholds?.sameErrorThreshold ?? STAGNATION_THRESHOLDS.SAME_ERROR_THRESHOLD;

    // Increment loop count
    exec.loopCount++;
    exec.lastFilesChanged = filesChanged;
    exec.updatedAt = now;

    // Track progress across multiple signals (Phase 2)
    const prevProgressMs = exec.lastProgressAt?.getTime() ?? 0;
    const signalMs = Math.max(
      filesChanged > 0 ? nowMs : 0,
      options?.progressSignals?.gitHeadCommitMs ?? 0,
      options?.progressSignals?.changedFilesMaxMtimeMs ?? 0,
      options?.progressSignals?.logMtimeMs ?? 0
    );

    // Treat the first observation as a baseline progress point to avoid immediate timeouts.
    const progressed = prevProgressMs === 0 || signalMs > prevProgressMs;

    let nextProgressMs = prevProgressMs;
    if (prevProgressMs === 0) {
      nextProgressMs = signalMs > 0 ? signalMs : nowMs;
    } else if (signalMs > prevProgressMs) {
      nextProgressMs = signalMs;
    }

    exec.lastProgressAt = new Date(nextProgressMs);

    // Track no progress (but only when none of the signals advanced)
    if (progressed) {
      exec.consecutiveNoProgress = 0;
    } else {
      exec.consecutiveNoProgress++;
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

    // Check if all stories are complete before marking as failed
    const stories = s.userStories.filter((st) => st.executionId === executionId);
    const allComplete = stories.length > 0 && stories.every((st) => st.passes);

    if (allComplete) {
      // All stories done - set to completed, not failed
      exec.status = "completed";
      return {
        isStagnant: false,
        type: null,
        message: "All stories complete",
        metrics,
      };
    }

    if (exec.consecutiveNoProgress >= noProgressThreshold) {
      const timeoutMs = options?.noProgressTimeoutMs;
      const idleMs = nowMs - (exec.lastProgressAt?.getTime() ?? nowMs);

      // Legacy behavior if no timeout configured: open circuit purely by loop threshold.
      const timedOut = typeof timeoutMs === "number" ? idleMs >= timeoutMs : true;

      if (timedOut) {
        exec.status = "failed";
        return {
          isStagnant: true,
          type: "no_progress" as StagnationType,
          message:
            typeof timeoutMs === "number"
              ? `Stagnation detected: No progress for ${exec.consecutiveNoProgress} loops (idle ${(idleMs / 60000).toFixed(1)}m, timeout ${(timeoutMs / 60000).toFixed(1)}m)`
              : `Stagnation detected: No file/progress signals for ${exec.consecutiveNoProgress} consecutive loops`,
          metrics,
        };
      }
    }

    if (exec.consecutiveErrors >= sameErrorThreshold) {
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
    exec.lastProgressAt = new Date();
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

/**
 * Restore a failed/stopped execution from the archive back into the active list.
 *
 * This is a safety valve for cases where a long-running agent session continues after the Runner (or reconcile)
 * archived a terminal execution record. The agent can then call `ralph_update` and recover tracking.
 */
export async function restoreArchivedExecutionByBranch(branch: string): Promise<ExecutionRecord | null> {
  return mutateState((s) => {
    const existing = s.executions.find((e) => e.branch === branch);
    if (existing) return existing;

    const candidates = s.archivedExecutions
      .map((e, idx) => ({ exec: e, idx }))
      .filter(({ exec }) => exec.branch === branch)
      .filter(({ exec }) => exec.status === "failed" || exec.status === "stopped");

    if (candidates.length === 0) return null;

    // Prefer failed over stopped, then most recent activity.
    const statusRank = (status: ExecutionStatus): number => (status === "failed" ? 0 : 1);
    candidates.sort((a, b) => {
      const rank = statusRank(a.exec.status) - statusRank(b.exec.status);
      if (rank !== 0) return rank;
      return b.exec.updatedAt.getTime() - a.exec.updatedAt.getTime();
    });

    const { exec: restored, idx } = candidates[0];
    s.archivedExecutions.splice(idx, 1);

    const storiesToRestore = s.archivedUserStories.filter((st) => st.executionId === restored.id);
    s.archivedUserStories = s.archivedUserStories.filter((st) => st.executionId !== restored.id);
    s.userStories.push(...storiesToRestore);

    restored.updatedAt = new Date();
    s.executions.push(restored);

    return restored;
  });
}
