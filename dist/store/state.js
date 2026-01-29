import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
export const RALPH_DATA_DIR = process.env.RALPH_DATA_DIR?.replace("~", homedir()) ||
    join(homedir(), ".ralph");
const STATE_PATH = join(RALPH_DATA_DIR, "state.json");
if (!existsSync(RALPH_DATA_DIR)) {
    mkdirSync(RALPH_DATA_DIR, { recursive: true });
}
function parseDate(value, fieldName) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid date in ${fieldName}: ${value}`);
    }
    return date;
}
function toIso(date) {
    return date.toISOString();
}
function defaultState() {
    return { executions: [], userStories: [], mergeQueue: [] };
}
function normalizeState(raw) {
    const base = {
        version: 1,
        executions: [],
        userStories: [],
        mergeQueue: [],
    };
    if (!raw || typeof raw !== "object")
        return base;
    const obj = raw;
    if (obj.version === 1)
        base.version = 1;
    if (Array.isArray(obj.executions))
        base.executions = obj.executions;
    if (Array.isArray(obj.userStories))
        base.userStories = obj.userStories;
    if (Array.isArray(obj.mergeQueue))
        base.mergeQueue = obj.mergeQueue;
    return base;
}
function deserializeState(file) {
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
function serializeState(state) {
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
let lock = Promise.resolve();
async function withLock(fn) {
    const previous = lock;
    let release;
    lock = new Promise((resolve) => {
        release = resolve;
    });
    await previous;
    try {
        return await fn();
    }
    finally {
        release();
    }
}
async function readStateUnlocked() {
    if (!existsSync(STATE_PATH))
        return defaultState();
    const rawText = await readFile(STATE_PATH, "utf-8");
    const rawJson = JSON.parse(rawText);
    const normalized = normalizeState(rawJson);
    return deserializeState(normalized);
}
async function writeStateUnlocked(state) {
    const file = serializeState(state);
    await writeFile(STATE_PATH, JSON.stringify(file, null, 2) + "\n", "utf-8");
}
async function mutateState(mutator) {
    return withLock(async () => {
        const state = await readStateUnlocked();
        const result = await mutator(state);
        await writeStateUnlocked(state);
        return result;
    });
}
async function readState(reader) {
    return withLock(async () => {
        const state = await readStateUnlocked();
        return await reader(state);
    });
}
export async function listExecutions() {
    return readState((s) => s.executions.slice());
}
export async function findExecutionByBranch(branch) {
    return readState((s) => s.executions.find((e) => e.branch === branch) ?? null);
}
export async function findExecutionById(executionId) {
    return readState((s) => s.executions.find((e) => e.id === executionId) ?? null);
}
export async function insertExecution(execution) {
    return mutateState((s) => {
        const existing = s.executions.find((e) => e.branch === execution.branch);
        if (existing) {
            throw new Error(`Execution already exists for branch ${execution.branch}`);
        }
        s.executions.push(execution);
    });
}
export async function updateExecution(executionId, patch) {
    return mutateState((s) => {
        const exec = s.executions.find((e) => e.id === executionId);
        if (!exec)
            throw new Error(`No execution found with id: ${executionId}`);
        Object.assign(exec, patch);
    });
}
export async function deleteExecution(executionId) {
    return mutateState((s) => {
        s.executions = s.executions.filter((e) => e.id !== executionId);
        s.userStories = s.userStories.filter((st) => st.executionId !== executionId);
        s.mergeQueue = s.mergeQueue.filter((q) => q.executionId !== executionId);
    });
}
export async function listUserStoriesByExecutionId(executionId) {
    return readState((s) => s.userStories.filter((st) => st.executionId === executionId));
}
export async function findUserStoryById(storyKey) {
    return readState((s) => s.userStories.find((st) => st.id === storyKey) ?? null);
}
export async function insertUserStories(stories) {
    return mutateState((s) => {
        for (const story of stories) {
            const existingIndex = s.userStories.findIndex((st) => st.id === story.id);
            if (existingIndex >= 0)
                s.userStories.splice(existingIndex, 1);
            s.userStories.push(story);
        }
    });
}
export async function updateUserStory(storyKey, patch) {
    return mutateState((s) => {
        const story = s.userStories.find((st) => st.id === storyKey);
        if (!story)
            throw new Error(`No story found with id: ${storyKey}`);
        Object.assign(story, patch);
    });
}
export async function listMergeQueue() {
    return readState((s) => s.mergeQueue
        .slice()
        .sort((a, b) => a.position - b.position || a.id - b.id));
}
export async function findMergeQueueItemByExecutionId(executionId) {
    return readState((s) => s.mergeQueue.find((q) => q.executionId === executionId) ?? null);
}
export async function insertMergeQueueItem(item) {
    return mutateState((s) => {
        const nextId = s.mergeQueue.reduce((maxId, q) => Math.max(maxId, q.id), 0) + 1;
        const created = { ...item, id: nextId };
        s.mergeQueue.push(created);
        return created;
    });
}
export async function updateMergeQueueItem(id, patch) {
    return mutateState((s) => {
        const item = s.mergeQueue.find((q) => q.id === id);
        if (!item)
            throw new Error(`No merge queue item found with id: ${id}`);
        Object.assign(item, patch);
    });
}
export async function deleteMergeQueueByExecutionId(executionId) {
    return mutateState((s) => {
        s.mergeQueue = s.mergeQueue.filter((q) => q.executionId !== executionId);
    });
}
