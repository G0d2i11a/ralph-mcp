"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STAGNATION_THRESHOLDS = exports.VALID_TRANSITIONS = exports.MAX_ARCHIVED_EXECUTIONS = exports.RALPH_DATA_DIR = void 0;
exports.isValidTransition = isValidTransition;
exports.getTransitionError = getTransitionError;
exports.listExecutions = listExecutions;
exports.findExecutionByBranch = findExecutionByBranch;
exports.findExecutionById = findExecutionById;
exports.insertExecution = insertExecution;
exports.updateExecution = updateExecution;
exports.deleteExecution = deleteExecution;
exports.listUserStoriesByExecutionId = listUserStoriesByExecutionId;
exports.findUserStoryById = findUserStoryById;
exports.insertUserStories = insertUserStories;
exports.updateUserStory = updateUserStory;
exports.listMergeQueue = listMergeQueue;
exports.findMergeQueueItemByExecutionId = findMergeQueueItemByExecutionId;
exports.insertMergeQueueItem = insertMergeQueueItem;
exports.updateMergeQueueItem = updateMergeQueueItem;
exports.deleteMergeQueueByExecutionId = deleteMergeQueueByExecutionId;
exports.findExecutionsDependingOn = findExecutionsDependingOn;
exports.areDependenciesSatisfied = areDependenciesSatisfied;
exports.checkStagnation = checkStagnation;
exports.recordLoopResult = recordLoopResult;
exports.resetStagnation = resetStagnation;
exports.archiveExecution = archiveExecution;
exports.listArchivedExecutions = listArchivedExecutions;
exports.listArchivedUserStoriesByExecutionId = listArchivedUserStoriesByExecutionId;
exports.findArchivedExecutionById = findArchivedExecutionById;
exports.findArchivedExecutionByBranch = findArchivedExecutionByBranch;
const fs_1 = require("fs");
const promises_1 = require("fs/promises");
const os_1 = require("os");
const path_1 = require("path");
exports.RALPH_DATA_DIR = process.env.RALPH_DATA_DIR?.replace("~", (0, os_1.homedir)()) ||
    (0, path_1.join)((0, os_1.homedir)(), ".ralph");
const STATE_PATH = (0, path_1.join)(exports.RALPH_DATA_DIR, "state.json");
/**
 * Maximum number of archived executions to retain.
 * Configurable via RALPH_MAX_ARCHIVED environment variable.
 */
exports.MAX_ARCHIVED_EXECUTIONS = parseInt(process.env.RALPH_MAX_ARCHIVED || "50", 10);
if (!(0, fs_1.existsSync)(exports.RALPH_DATA_DIR)) {
    (0, fs_1.mkdirSync)(exports.RALPH_DATA_DIR, { recursive: true });
}
/**
 * Valid state transitions for ExecutionStatus.
 * Key: current status, Value: array of valid next statuses
 */
exports.VALID_TRANSITIONS = {
    pending: ["ready", "running", "stopped", "failed"], // ready when deps satisfied, running if no deps
    ready: ["starting", "stopped", "failed", "pending"], // starting when Runner claims, back to pending if deps change
    starting: ["running", "ready", "failed", "stopped"], // running when Agent starts, ready on launch failure (retry)
    running: ["completed", "failed", "stopped", "merging", "interrupted"], // normal execution flow + interrupt detection
    interrupted: ["ready", "failed"], // ready for auto-retry, failed if max retries exceeded
    completed: ["merging"], // only to merging
    failed: ["running", "ready", "stopped"], // retry scenarios
    stopped: ["ready"], // can be retried via ralph_retry
    merging: ["merged", "failed"], // merge result: merged on success, failed on error
    merged: [], // terminal state after successful merge
};
/**
 * Check if a status transition is valid.
 */
function isValidTransition(from, to) {
    return exports.VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
/**
 * Get a human-readable error message for invalid transitions.
 */
function getTransitionError(from, to) {
    const validTargets = exports.VALID_TRANSITIONS[from];
    if (validTargets.length === 0) {
        return `Cannot transition from '${from}' - it is a terminal state`;
    }
    return `Invalid transition from '${from}' to '${to}'. Valid transitions: ${validTargets.join(", ")}`;
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
    return { executions: [], userStories: [], mergeQueue: [], archivedExecutions: [], archivedUserStories: [] };
}
function normalizeState(raw) {
    const base = {
        version: 1,
        executions: [],
        userStories: [],
        mergeQueue: [],
        archivedExecutions: [],
        archivedUserStories: [],
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
    if (Array.isArray(obj.archivedExecutions))
        base.archivedExecutions = obj.archivedExecutions;
    if (Array.isArray(obj.archivedUserStories))
        base.archivedUserStories = obj.archivedUserStories;
    return base;
}
function deserializeState(file) {
    const deserializeExecution = (e) => ({
        ...e,
        dependencies: Array.isArray(e.dependencies) ? e.dependencies : [],
        // Stagnation detection defaults for backward compatibility
        loopCount: typeof e.loopCount === "number" ? e.loopCount : 0,
        consecutiveNoProgress: typeof e.consecutiveNoProgress === "number" ? e.consecutiveNoProgress : 0,
        consecutiveErrors: typeof e.consecutiveErrors === "number" ? e.consecutiveErrors : 0,
        lastError: typeof e.lastError === "string" ? e.lastError : null,
        lastFilesChanged: typeof e.lastFilesChanged === "number" ? e.lastFilesChanged : 0,
        // Current activity tracking defaults for backward compatibility
        currentStoryId: typeof e.currentStoryId === "string" ? e.currentStoryId : null,
        currentStep: typeof e.currentStep === "string" ? e.currentStep : null,
        stepStartedAt: typeof e.stepStartedAt === "string" ? parseDate(e.stepStartedAt, "executions.stepStartedAt") : null,
        logPath: typeof e.logPath === "string" ? e.logPath : null,
        // Launch recovery defaults for backward compatibility (US-006)
        launchAttemptAt: typeof e.launchAttemptAt === "string" ? parseDate(e.launchAttemptAt, "executions.launchAttemptAt") : null,
        launchAttempts: typeof e.launchAttempts === "number" ? e.launchAttempts : 0,
        // Merge tracking defaults for backward compatibility
        mergedAt: typeof e.mergedAt === "string" ? parseDate(e.mergedAt, "executions.mergedAt") : null,
        mergeCommitSha: typeof e.mergeCommitSha === "string" ? e.mergeCommitSha : null,
        // Reconcile tracking defaults for backward compatibility
        reconcileReason: e.reconcileReason || null,
        createdAt: parseDate(e.createdAt, "executions.createdAt"),
        updatedAt: parseDate(e.updatedAt, "executions.updatedAt"),
    });
    const deserializeUserStory = (s) => ({
        ...s,
        acceptanceCriteria: Array.isArray(s.acceptanceCriteria)
            ? s.acceptanceCriteria
            : [],
        notes: typeof s.notes === "string" ? s.notes : "",
        acEvidence: typeof s.acEvidence === "object" && s.acEvidence !== null
            ? s.acEvidence
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
function serializeState(state) {
    const serializeExecution = (e) => ({
        ...e,
        stepStartedAt: e.stepStartedAt ? toIso(e.stepStartedAt) : null,
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
    if (!(0, fs_1.existsSync)(STATE_PATH))
        return defaultState();
    const rawText = await (0, promises_1.readFile)(STATE_PATH, "utf-8");
    const rawJson = JSON.parse(rawText);
    const normalized = normalizeState(rawJson);
    return deserializeState(normalized);
}
async function writeStateUnlocked(state) {
    const file = serializeState(state);
    await (0, promises_1.writeFile)(STATE_PATH, JSON.stringify(file, null, 2) + "\n", "utf-8");
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
async function listExecutions() {
    return readState((s) => s.executions.slice());
}
async function findExecutionByBranch(branch) {
    return readState((s) => s.executions.find((e) => e.branch === branch) ?? null);
}
async function findExecutionById(executionId) {
    return readState((s) => s.executions.find((e) => e.id === executionId) ?? null);
}
async function insertExecution(execution) {
    return mutateState((s) => {
        const existing = s.executions.find((e) => e.branch === execution.branch);
        if (existing) {
            throw new Error(`Execution already exists for branch ${execution.branch}`);
        }
        s.executions.push(execution);
    });
}
async function updateExecution(executionId, patch, options) {
    return mutateState((s) => {
        const exec = s.executions.find((e) => e.id === executionId);
        if (!exec)
            throw new Error(`No execution found with id: ${executionId}`);
        // Validate state transition if status is being changed
        if (patch.status && patch.status !== exec.status && !options?.skipTransitionValidation) {
            if (!isValidTransition(exec.status, patch.status)) {
                throw new Error(getTransitionError(exec.status, patch.status));
            }
        }
        Object.assign(exec, patch);
    });
}
async function deleteExecution(executionId) {
    return mutateState((s) => {
        s.executions = s.executions.filter((e) => e.id !== executionId);
        s.userStories = s.userStories.filter((st) => st.executionId !== executionId);
        s.mergeQueue = s.mergeQueue.filter((q) => q.executionId !== executionId);
    });
}
async function listUserStoriesByExecutionId(executionId) {
    return readState((s) => s.userStories.filter((st) => st.executionId === executionId));
}
async function findUserStoryById(storyKey) {
    return readState((s) => s.userStories.find((st) => st.id === storyKey) ?? null);
}
async function insertUserStories(stories) {
    return mutateState((s) => {
        for (const story of stories) {
            const existingIndex = s.userStories.findIndex((st) => st.id === story.id);
            if (existingIndex >= 0)
                s.userStories.splice(existingIndex, 1);
            s.userStories.push(story);
        }
    });
}
async function updateUserStory(storyKey, patch) {
    return mutateState((s) => {
        const story = s.userStories.find((st) => st.id === storyKey);
        if (!story)
            throw new Error(`No story found with id: ${storyKey}`);
        Object.assign(story, patch);
    });
}
async function listMergeQueue() {
    return readState((s) => s.mergeQueue
        .slice()
        .sort((a, b) => a.position - b.position || a.id - b.id));
}
async function findMergeQueueItemByExecutionId(executionId) {
    return readState((s) => s.mergeQueue.find((q) => q.executionId === executionId) ?? null);
}
async function insertMergeQueueItem(item) {
    return mutateState((s) => {
        const nextId = s.mergeQueue.reduce((maxId, q) => Math.max(maxId, q.id), 0) + 1;
        const created = { ...item, id: nextId };
        s.mergeQueue.push(created);
        return created;
    });
}
async function updateMergeQueueItem(id, patch) {
    return mutateState((s) => {
        const item = s.mergeQueue.find((q) => q.id === id);
        if (!item)
            throw new Error(`No merge queue item found with id: ${id}`);
        Object.assign(item, patch);
    });
}
async function deleteMergeQueueByExecutionId(executionId) {
    return mutateState((s) => {
        s.mergeQueue = s.mergeQueue.filter((q) => q.executionId !== executionId);
    });
}
/**
 * Find all executions that depend on a given branch.
 */
async function findExecutionsDependingOn(branch) {
    return readState((s) => s.executions.filter((e) => e.dependencies.includes(branch)));
}
/**
 * Check if all dependencies of an execution are completed.
 * Checks both active executions (status: "completed") and archived executions (status: "merged").
 */
async function areDependenciesSatisfied(execution) {
    if (!execution.dependencies || execution.dependencies.length === 0) {
        return { satisfied: true, pending: [], completed: [] };
    }
    return readState((s) => {
        const pending = [];
        const completed = [];
        for (const depBranch of execution.dependencies) {
            // Check active executions first
            const depExec = s.executions.find((e) => e.branch === depBranch);
            if (depExec && depExec.status === "completed") {
                completed.push(depBranch);
                continue;
            }
            // Check archived executions (merged PRDs are archived)
            const archivedExec = s.archivedExecutions.find((e) => e.branch === depBranch);
            if (archivedExec && (archivedExec.status === "merged" || archivedExec.status === "completed")) {
                completed.push(depBranch);
                continue;
            }
            // Dependency not satisfied
            pending.push(depBranch);
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
exports.STAGNATION_THRESHOLDS = {
    NO_PROGRESS_THRESHOLD: 3, // Open circuit after 3 loops with no file changes
    SAME_ERROR_THRESHOLD: 5, // Open circuit after 5 loops with repeated errors
    MAX_LOOPS_PER_STORY: 10, // Safety limit per story
};
/**
 * Check if an execution is stagnant (stuck in a loop).
 */
async function checkStagnation(executionId) {
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
        if (exec.consecutiveNoProgress >= exports.STAGNATION_THRESHOLDS.NO_PROGRESS_THRESHOLD) {
            return {
                isStagnant: true,
                type: "no_progress",
                message: `No file changes for ${exec.consecutiveNoProgress} consecutive loops (threshold: ${exports.STAGNATION_THRESHOLDS.NO_PROGRESS_THRESHOLD})`,
                metrics,
            };
        }
        // Check repeated error threshold
        if (exec.consecutiveErrors >= exports.STAGNATION_THRESHOLDS.SAME_ERROR_THRESHOLD) {
            return {
                isStagnant: true,
                type: "repeated_error",
                message: `Same error repeated ${exec.consecutiveErrors} times (threshold: ${exports.STAGNATION_THRESHOLDS.SAME_ERROR_THRESHOLD}): ${exec.lastError?.slice(0, 100)}`,
                metrics,
            };
        }
        // Check max loops per story
        const stories = s.userStories.filter((st) => st.executionId === executionId);
        const pendingStories = stories.filter((st) => !st.passes);
        if (pendingStories.length > 0 && exec.loopCount >= exports.STAGNATION_THRESHOLDS.MAX_LOOPS_PER_STORY * pendingStories.length) {
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
async function recordLoopResult(executionId, filesChanged, error) {
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
        }
        else {
            exec.consecutiveNoProgress = 0;
        }
        // Track repeated errors
        if (error) {
            if (exec.lastError === error) {
                exec.consecutiveErrors++;
            }
            else {
                exec.consecutiveErrors = 1;
                exec.lastError = error;
            }
        }
        else {
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
        if (exec.consecutiveNoProgress >= exports.STAGNATION_THRESHOLDS.NO_PROGRESS_THRESHOLD) {
            exec.status = "failed";
            return {
                isStagnant: true,
                type: "no_progress",
                message: `Stagnation detected: No file changes for ${exec.consecutiveNoProgress} consecutive loops`,
                metrics,
            };
        }
        if (exec.consecutiveErrors >= exports.STAGNATION_THRESHOLDS.SAME_ERROR_THRESHOLD) {
            exec.status = "failed";
            return {
                isStagnant: true,
                type: "repeated_error",
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
async function resetStagnation(executionId) {
    return mutateState((s) => {
        const exec = s.executions.find((e) => e.id === executionId);
        if (!exec)
            throw new Error(`No execution found with id: ${executionId}`);
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
async function archiveExecution(executionId) {
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
        if (s.archivedExecutions.length > exports.MAX_ARCHIVED_EXECUTIONS) {
            // Sort by mergedAt (or updatedAt as fallback), oldest first
            s.archivedExecutions.sort((a, b) => {
                const aTime = (a.mergedAt || a.updatedAt).getTime();
                const bTime = (b.mergedAt || b.updatedAt).getTime();
                return aTime - bTime;
            });
            // Calculate how many to remove
            const toRemove = s.archivedExecutions.length - exports.MAX_ARCHIVED_EXECUTIONS;
            const removedExecutions = s.archivedExecutions.splice(0, toRemove);
            // Remove associated user stories for deleted archives
            const removedIds = new Set(removedExecutions.map((e) => e.id));
            s.archivedUserStories = s.archivedUserStories.filter((st) => !removedIds.has(st.executionId));
        }
    });
}
/**
 * List all archived executions.
 */
async function listArchivedExecutions() {
    return readState((s) => s.archivedExecutions.slice());
}
/**
 * List archived user stories by execution ID.
 */
async function listArchivedUserStoriesByExecutionId(executionId) {
    return readState((s) => s.archivedUserStories.filter((st) => st.executionId === executionId));
}
/**
 * Find an archived execution by ID.
 */
async function findArchivedExecutionById(executionId) {
    return readState((s) => s.archivedExecutions.find((e) => e.id === executionId) ?? null);
}
/**
 * Find an archived execution by branch name.
 */
async function findArchivedExecutionByBranch(branch) {
    return readState((s) => s.archivedExecutions.find((e) => e.branch === branch) ?? null);
}
