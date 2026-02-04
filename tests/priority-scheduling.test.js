import { before, beforeEach, after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir;
let state;
let Runner;

async function resetStateFiles() {
  await rm(join(dataDir, "state.json"), { force: true });
  await rm(join(dataDir, "state.lock"), { force: true });

  const entries = await readdir(dataDir);
  await Promise.all(
    entries
      .filter((name) => name.startsWith("state.json.backup-"))
      .map((name) => rm(join(dataDir, name), { force: true }))
  );
}

function makeExecution(overrides = {}) {
  const now = new Date();
  return {
    id: "exec",
    project: "test-project",
    branch: "ralph/test",
    description: "test",
    priority: "P1",
    prdPath: "test.md",
    projectRoot: dataDir,
    worktreePath: null,
    baseCommitSha: null,
    status: "ready",
    agentTaskId: null,
    onConflict: null,
    autoMerge: false,
    notifyOnComplete: false,
    dependencies: [],
    loopCount: 0,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastError: null,
    lastFilesChanged: 0,
    currentStoryId: null,
    currentStep: null,
    stepStartedAt: null,
    logPath: null,
    launchAttemptAt: null,
    launchAttempts: 0,
    mergedAt: null,
    mergeCommitSha: null,
    reconcileReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function waitUntil(fn, { timeoutMs = 2000, intervalMs = 25 } = {}) {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    const ok = await fn();
    if (ok) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ralph-mcp-test-"));
  process.env.RALPH_DATA_DIR = dataDir;

  state = await import("../dist/store/state.js");
  ({ Runner } = await import("../dist/runner.js"));
});

beforeEach(async () => {
  await resetStateFiles();
});

after(async () => {
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("parsePrdMarkdown reads frontmatter priority and defaults invalid", async () => {
  const { parsePrdFile } = await import("../dist/utils/prd-parser.js");

  const prdPath = join(dataDir, "prd.md");
  await writeFile(prdPath, "---\npriority: P0\n---\n# My PRD\n", "utf-8");
  assert.equal(parsePrdFile(prdPath).priority, "P0");

  await writeFile(prdPath, "---\npriority: p2\n---\n# My PRD\n", "utf-8");
  assert.equal(parsePrdFile(prdPath).priority, "P2");

  await writeFile(prdPath, "---\npriority: P3\n---\n# My PRD\n", "utf-8");
  assert.equal(parsePrdFile(prdPath).priority, "P1");
});

test("state.json loading defaults missing priority to P1", async () => {
  const now = new Date().toISOString();

  const stateFile = {
    version: 1,
    executions: [
      {
        id: "e1",
        project: "test-project",
        branch: "ralph/legacy",
        description: "legacy",
        prdPath: "legacy.md",
        projectRoot: dataDir,
        worktreePath: null,
        status: "ready",
        agentTaskId: null,
        onConflict: null,
        autoMerge: false,
        notifyOnComplete: false,
        dependencies: [],
        stepStartedAt: null,
        logPath: null,
        launchAttemptAt: null,
        launchAttempts: 0,
        mergedAt: null,
        mergeCommitSha: null,
        reconcileReason: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    userStories: [],
    mergeQueue: [],
    archivedExecutions: [],
    archivedUserStories: [],
  };

  await writeFile(join(dataDir, "state.json"), JSON.stringify(stateFile, null, 2), "utf-8");

  const execs = await state.listExecutions();
  assert.equal(execs.length, 1);
  assert.equal(execs[0].priority, "P1");
});

test("runner schedules P0 before P1/P2 (concurrency=1)", async () => {
  const launched = [];
  const launcher = {
    launch: async (_prompt, _cwd, executionId) => {
      launched.push(executionId);
      return { success: true, agentTaskId: `agent-${executionId}`, logPath: null };
    },
  };

  const runner = new Runner({ concurrency: 1, onLog: () => {} }, launcher);

  const base = Date.now();
  await state.insertExecution(
    makeExecution({
      id: "p2",
      branch: "ralph/p2",
      priority: "P2",
      status: "ready",
      createdAt: new Date(base),
      updatedAt: new Date(base),
    })
  );
  await state.insertExecution(
    makeExecution({
      id: "p0",
      branch: "ralph/p0",
      priority: "P0",
      status: "ready",
      createdAt: new Date(base + 10_000), // newer, but should still win due to priority
      updatedAt: new Date(base + 10_000),
    })
  );
  await state.insertExecution(
    makeExecution({
      id: "p1",
      branch: "ralph/p1",
      priority: "P1",
      status: "ready",
      createdAt: new Date(base + 5_000),
      updatedAt: new Date(base + 5_000),
    })
  );

  await runner.processReadyPrds();

  await waitUntil(async () => launched.length === 1);

  const execs = await state.listExecutions();
  const running = execs.filter((e) => e.status === "running");
  assert.equal(running.length, 1);
  assert.equal(running[0].branch, "ralph/p0");
  assert.equal(running[0].priority, "P0");
});

test("runner never exceeds effective concurrency (global running/starting)", async () => {
  const launched = [];
  const launcher = {
    launch: async (_prompt, _cwd, executionId) => {
      launched.push(executionId);
      return { success: true, agentTaskId: `agent-${executionId}`, logPath: null };
    },
  };

  const runner = new Runner({ concurrency: 2, onLog: () => {} }, launcher);

  const base = Date.now();
  await state.insertExecution(
    makeExecution({
      id: "r1",
      branch: "ralph/r1",
      status: "running",
      createdAt: new Date(base),
      updatedAt: new Date(base),
    })
  );
  await state.insertExecution(
    makeExecution({
      id: "r2",
      branch: "ralph/r2",
      status: "running",
      createdAt: new Date(base),
      updatedAt: new Date(base),
    })
  );
  await state.insertExecution(
    makeExecution({
      id: "ready",
      branch: "ralph/ready",
      priority: "P0",
      status: "ready",
      createdAt: new Date(base),
      updatedAt: new Date(base),
    })
  );

  await runner.processReadyPrds();

  // Give any incorrect background launches a chance to start
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(launched.length, 0);
  const execs = await state.listExecutions();
  assert.equal(execs.filter((e) => e.status === "running").length, 2);
  assert.equal(execs.find((e) => e.id === "ready")?.status, "ready");
});

test("runner warns once when global running/starting exceeds configured concurrency", async () => {
  const logs = [];
  const launcher = {
    launch: async () => {
      throw new Error("unexpected launch");
    },
  };

  const runner = new Runner(
    {
      concurrency: 1,
      onLog: (level, message) => logs.push({ level, message }),
    },
    launcher
  );

  const base = Date.now();
  await state.insertExecution(
    makeExecution({
      id: "over-1",
      branch: "ralph/over-1",
      status: "running",
      createdAt: new Date(base),
      updatedAt: new Date(base),
    })
  );
  await state.insertExecution(
    makeExecution({
      id: "over-2",
      branch: "ralph/over-2",
      status: "running",
      createdAt: new Date(base),
      updatedAt: new Date(base),
    })
  );

  await runner.processReadyPrds();
  await runner.processReadyPrds();

  const warns = logs.filter(
    (l) => l.level === "warn" && l.message.includes("exceeds configured concurrency")
  );
  assert.equal(warns.length, 1);
});

test("runner recovers PRDs stuck in starting (revert to ready)", async () => {
  const launcher = {
    launch: async () => {
      throw new Error("launch should not be called for timeout recovery");
    },
  };

  const runner = new Runner({ launchTimeout: 30_000, maxRetries: 3, onLog: () => {} }, launcher);

  await state.insertExecution(
    makeExecution({
      id: "s-starting",
      branch: "ralph/starting-timeout",
      status: "starting",
      launchAttemptAt: new Date(Date.now() - 35_000),
      launchAttempts: 1,
    })
  );

  await runner.recoverTimedOutPrds();

  const exec = await state.findExecutionByBranch("ralph/starting-timeout");
  assert.equal(exec?.status, "ready");
  assert.match(exec?.lastError ?? "", /Launch timeout/);
});

test("runner recovers PRDs stuck in starting (mark failed after max retries)", async () => {
  const launcher = {
    launch: async () => {
      throw new Error("launch should not be called for timeout recovery");
    },
  };

  const runner = new Runner({ launchTimeout: 30_000, maxRetries: 3, onLog: () => {} }, launcher);

  await state.insertExecution(
    makeExecution({
      id: "s-starting-max",
      branch: "ralph/starting-max-retries",
      status: "starting",
      launchAttemptAt: new Date(Date.now() - 35_000),
      launchAttempts: 3,
    })
  );

  await runner.recoverTimedOutPrds();

  const exec = await state.findExecutionByBranch("ralph/starting-max-retries");
  assert.equal(exec?.status, "failed");
  assert.match(exec?.lastError ?? "", /Launch failed after 3 attempts/);
});

test("status output includes execution priority", async () => {
  const { status } = await import("../dist/tools/status.js");

  await state.insertExecution(
    makeExecution({
      id: "s1",
      branch: "ralph/status",
      priority: "P2",
      status: "ready",
    })
  );

  const result = await status({ reconcile: false, historyLimit: 0 });
  const exec = result.executions.find((e) => e.branch === "ralph/status");
  assert.ok(exec, "expected execution in status output");
  assert.equal(exec.priority, "P2");
});
