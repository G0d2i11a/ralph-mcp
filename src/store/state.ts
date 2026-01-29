import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export const RALPH_DATA_DIR =
  process.env.RALPH_DATA_DIR?.replace("~", homedir()) ||
  join(homedir(), ".ralph");

const STATE_PATH = join(RALPH_DATA_DIR, "state.json");

if (!existsSync(RALPH_DATA_DIR)) {
  mkdirSync(RALPH_DATA_DIR, { recursive: true });
}

export type ExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "merging";

export type ConflictStrategy = "auto_theirs" | "auto_ours" | "notify" | "agent";

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
  onConflict: ConflictStrategy | null;
  autoMerge: boolean;
  notifyOnComplete: boolean;
  createdAt: Date;
  updatedAt: Date;
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
  executions: Array<Omit<ExecutionRecord, "createdAt" | "updatedAt"> & { createdAt: string; updatedAt: string }>;
  userStories: UserStoryRecord[];
  mergeQueue: Array<Omit<MergeQueueItem, "createdAt"> & { createdAt: string }>;
}

interface StateRuntime {
  executions: ExecutionRecord[];
  userStories: UserStoryRecord[];
  mergeQueue: MergeQueueItem[];
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
  return { executions: [], userStories: [], mergeQueue: [] };
}

function normalizeState(raw: unknown): StateFileV1 {
  const base: StateFileV1 = {
    version: 1,
    executions: [],
    userStories: [],
    mergeQueue: [],
  };

  if (!raw || typeof raw !== "object") return base;

  const obj = raw as Record<string, unknown>;
  if (obj.version === 1) base.version = 1;
  if (Array.isArray(obj.executions)) base.executions = obj.executions as StateFileV1["executions"];
  if (Array.isArray(obj.userStories)) base.userStories = obj.userStories as StateFileV1["userStories"];
  if (Array.isArray(obj.mergeQueue)) base.mergeQueue = obj.mergeQueue as StateFileV1["mergeQueue"];
  return base;
}

function deserializeState(file: StateFileV1): StateRuntime {
  return {
    executions: file.executions.map((e) => ({
      ...e,
      createdAt: parseDate(e.createdAt, "executions.createdAt"),
      updatedAt: parseDate(e.updatedAt, "executions.updatedAt"),
    })),
    userStories: file.userStories.map((s) => ({
      ...s,
      acceptanceCriteria: Array.isArray(s.acceptanceCriteria)
        ? s.acceptanceCriteria
        : [],
      notes: typeof s.notes === "string" ? s.notes : "",
    })),
    mergeQueue: file.mergeQueue.map((q) => ({
      ...q,
      createdAt: parseDate(q.createdAt, "mergeQueue.createdAt"),
    })),
  };
}

function serializeState(state: StateRuntime): StateFileV1 {
  return {
    version: 1,
    executions: state.executions.map((e) => ({
      ...e,
      createdAt: toIso(e.createdAt),
      updatedAt: toIso(e.updatedAt),
    })),
    userStories: state.userStories,
    mergeQueue: state.mergeQueue.map((q) => ({
      ...q,
      createdAt: toIso(q.createdAt),
    })),
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
  patch: Partial<Omit<ExecutionRecord, "id" | "createdAt">> & { updatedAt?: Date }
): Promise<void> {
  return mutateState((s) => {
    const exec = s.executions.find((e) => e.id === executionId);
    if (!exec) throw new Error(`No execution found with id: ${executionId}`);
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
