import { before, beforeEach, after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir;
let state;
let claimReady;

async function resetStateFiles() {
  await rm(join(dataDir, "state.json"), { force: true });
  await rm(join(dataDir, "state.lock"), { force: true });
  await rm(join(dataDir, "runner.lock"), { force: true });

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

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ralph-mcp-test-"));
  process.env.RALPH_DATA_DIR = dataDir;

  state = await import("../dist/store/state.js");
  ({ claimReady } = await import("../dist/tools/claim-ready.js"));
});

beforeEach(async () => {
  await resetStateFiles();
});

after(async () => {
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("claimReady is atomic: only one caller can claim a ready PRD", async () => {
  await state.insertExecution(
    makeExecution({
      id: "atomic",
      branch: "ralph/atomic",
      status: "ready",
      launchAttempts: 0,
      launchAttemptAt: null,
    })
  );

  const results = await Promise.all(
    Array.from({ length: 5 }, () => claimReady({ branch: "ralph/atomic" }))
  );

  const successes = results.filter((r) => r.success);
  assert.equal(successes.length, 1);

  const exec = await state.findExecutionByBranch("ralph/atomic");
  assert.equal(exec?.status, "starting");
  assert.equal(exec?.launchAttempts, 1);
});

test("claimReady enforces global runnerConfig.maxConcurrency", async () => {
  await state.setRunnerMaxConcurrency(1, "test");

  await state.insertExecution(
    makeExecution({
      id: "running",
      branch: "ralph/running",
      status: "running",
    })
  );

  await state.insertExecution(
    makeExecution({
      id: "blocked",
      branch: "ralph/blocked",
      status: "ready",
      launchAttempts: 0,
      launchAttemptAt: null,
    })
  );

  const result = await claimReady({ branch: "ralph/blocked" });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Global concurrency limit reached/);

  const exec = await state.findExecutionByBranch("ralph/blocked");
  assert.equal(exec?.status, "ready");
  assert.equal(exec?.launchAttempts, 0);
});

