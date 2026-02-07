"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inferTaskType = inferTaskType;
exports.getGitHeadInfo = getGitHeadInfo;
exports.getChangedFilesInfo = getChangedFilesInfo;
exports.getLogMtimeMs = getLogMtimeMs;
exports.evaluateExecutionStaleness = evaluateExecutionStaleness;
const child_process_1 = require("child_process");
const promises_1 = require("fs/promises");
const path_1 = require("path");
const util_1 = require("util");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
function clampPositiveInt(value, fallback) {
    if (!Number.isFinite(value))
        return fallback;
    return Math.max(0, Math.floor(value));
}
function normalizeTaskTypeFromText(text) {
    const lower = text.toLowerCase();
    if (/\b(verifying|verify|verification)\b/.test(lower))
        return "verifying";
    if (/\b(testing|tests?|jest|vitest|cypress|playwright|pytest)\b/.test(lower))
        return "testing";
    if (/\b(building|build|compile|compiling|bundle|bundling|webpack|vite|next build)\b/.test(lower))
        return "building";
    if (/\b(implementing|implement|coding|refactor|fix|debug)\b/.test(lower))
        return "implementing";
    return "unknown";
}
function inferTaskType(input) {
    const candidates = [
        input.currentStep,
        input.extraText,
        input.gitHeadMessage,
        input.lastError,
        input.logTail,
    ]
        .filter((v) => typeof v === "string" && v.trim().length > 0)
        .slice(0, 5);
    const score = (t) => {
        if (t === "testing" || t === "building" || t === "verifying")
            return 3;
        if (t === "implementing")
            return 1;
        return 0;
    };
    let best = "unknown";
    let bestScore = 0;
    for (const text of candidates) {
        const t = normalizeTaskTypeFromText(text);
        const s = score(t);
        if (s > bestScore) {
            best = t;
            bestScore = s;
        }
    }
    return best;
}
function timeoutForTaskType(taskType, config) {
    switch (taskType) {
        case "implementing":
            return config.timeoutsMs.implementing;
        case "building":
            return config.timeoutsMs.building;
        case "testing":
            return config.timeoutsMs.testing;
        case "verifying":
            return config.timeoutsMs.verifying;
        default:
            return config.timeoutsMs.unknown;
    }
}
async function readFileTail(path, maxBytes) {
    const bytes = clampPositiveInt(maxBytes, 0);
    if (bytes <= 0)
        return null;
    try {
        const handle = await (0, promises_1.open)(path, "r");
        try {
            const st = await handle.stat();
            const start = Math.max(0, st.size - bytes);
            const length = st.size - start;
            if (length <= 0)
                return "";
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, start);
            return buffer.toString("utf8");
        }
        finally {
            await handle.close();
        }
    }
    catch {
        return null;
    }
}
async function getGitHeadInfo(gitCwd) {
    try {
        const { stdout } = await execAsync("git log -1 --format=%H%n%ct%n%B", {
            cwd: gitCwd,
            maxBuffer: 2 * 1024 * 1024,
        });
        const lines = stdout.split(/\r?\n/);
        const sha = lines[0]?.trim() || null;
        const commitSec = lines[1]?.trim() || "";
        const commitMs = commitSec ? parseInt(commitSec, 10) * 1000 : NaN;
        const message = lines.slice(2).join("\n").trim() || null;
        return {
            sha,
            commitMs: Number.isFinite(commitMs) ? commitMs : null,
            message,
        };
    }
    catch {
        return { sha: null, commitMs: null, message: null };
    }
}
function parsePorcelainFilePath(line) {
    if (!line || line.length < 4)
        return null;
    const raw = line.slice(3).trim();
    if (!raw)
        return null;
    const renamed = raw.includes(" -> ") ? raw.split(" -> ").pop() : raw;
    if (!renamed)
        return null;
    // Best-effort unquote.
    if (renamed.startsWith('"') && renamed.endsWith('"')) {
        return renamed.slice(1, -1);
    }
    return renamed;
}
async function getChangedFilesInfo(worktreePath, maxFilesToStat) {
    try {
        const { stdout } = await execAsync("git status --porcelain", {
            cwd: worktreePath,
            maxBuffer: 2 * 1024 * 1024,
        });
        const files = stdout
            .split(/\r?\n/)
            .map((line) => parsePorcelainFilePath(line))
            .filter((v) => typeof v === "string" && v.length > 0);
        const limit = clampPositiveInt(maxFilesToStat, 0);
        const toSample = limit > 0 ? files.slice(0, limit) : [];
        const mtimes = await Promise.all(toSample.map(async (rel) => {
            try {
                const full = (0, path_1.join)(worktreePath, rel);
                const st = await (0, promises_1.stat)(full);
                return st.mtimeMs;
            }
            catch {
                return null;
            }
        }));
        const maxMtimeMs = mtimes
            .filter((v) => typeof v === "number" && Number.isFinite(v))
            .reduce((acc, v) => Math.max(acc, v), 0) || null;
        return { files, maxMtimeMs, sampled: toSample.length };
    }
    catch {
        return { files: [], maxMtimeMs: null, sampled: 0 };
    }
}
async function getLogMtimeMs(logPath) {
    try {
        const st = await (0, promises_1.stat)(logPath);
        return Number.isFinite(st.mtimeMs) ? st.mtimeMs : null;
    }
    catch {
        return null;
    }
}
async function evaluateExecutionStaleness(execLike, config, nowMs = Date.now()) {
    const gitCwd = execLike.worktreePath || execLike.projectRoot;
    const signals = {};
    const debug = {};
    if (config.signals.stateUpdatedAt) {
        signals.stateUpdatedAtMs = execLike.updatedAt.getTime();
    }
    let gitHead = null;
    if (config.signals.gitCommits) {
        gitHead = await getGitHeadInfo(gitCwd);
        if (gitHead.commitMs)
            signals.gitHeadCommitMs = gitHead.commitMs;
        debug.gitHeadSha = gitHead.sha;
        debug.gitHeadMessage = gitHead.message;
    }
    let logTail = null;
    let logMtimeMs = null;
    if (config.signals.logMtime && execLike.logPath) {
        logMtimeMs = await getLogMtimeMs(execLike.logPath);
        if (logMtimeMs)
            signals.logMtimeMs = logMtimeMs;
        // Only read log tail when it can help task inference.
        const stepType = inferTaskType({ currentStep: execLike.currentStep });
        const stepConfident = stepType === "testing" || stepType === "building" || stepType === "verifying";
        if (!stepConfident && config.logTailBytes > 0) {
            logTail = await readFileTail(execLike.logPath, config.logTailBytes);
        }
    }
    if (config.signals.fileChanges) {
        const changed = await getChangedFilesInfo(gitCwd, config.maxFilesToStat);
        if (changed.maxMtimeMs)
            signals.changedFilesMaxMtimeMs = changed.maxMtimeMs;
        debug.changedFilesCount = changed.files.length;
        debug.changedFilesSampled = changed.sampled;
    }
    const taskType = inferTaskType({
        currentStep: execLike.currentStep,
        lastError: execLike.lastError,
        gitHeadMessage: gitHead?.message || null,
        logTail,
    });
    const timeoutMs = timeoutForTaskType(taskType, config);
    const candidateActivityMs = [
        signals.stateUpdatedAtMs,
        signals.gitHeadCommitMs,
        signals.changedFilesMaxMtimeMs,
        signals.logMtimeMs,
    ].filter((v) => typeof v === "number" && Number.isFinite(v));
    const lastActivityMs = candidateActivityMs.reduce((acc, v) => Math.max(acc, v), 0) ||
        execLike.updatedAt.getTime();
    const idleMs = Math.max(0, nowMs - lastActivityMs);
    const isStale = Boolean(config.enabled) && idleMs > timeoutMs;
    return {
        isStale,
        taskType,
        timeoutMs,
        idleMs,
        lastActivityMs,
        signals,
        debug,
    };
}
