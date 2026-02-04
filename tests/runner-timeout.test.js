import { before, beforeEach, after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
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

test("runner does not time out starting PRDs it is actively launching", async () => {
  const launcher = {
    launch: async (_prompt, _cwd, executionId) => {
      return { success: true, agentTaskId: `agent-${executionId}`, logPath: null };
    },
  };

  const runner = new Runner({ concurrency: 1, launchTimeout: 1000, onLog: () => {} }, launcher);

  const now = Date.now();
  await state.insertExecution(
    makeExecution({
      id: "t1",
      branch: "ralph/t1",
      status: "starting",
      launchAttemptAt: new Date(now - 10_000),
      launchAttempts: 1,
      createdAt: new Date(now - 10_000),
      updatedAt: new Date(now - 10_000),
    })
  );

  runner.activeLaunches.add("ralph/t1");

  await runner.recoverTimedOutPrds();
  const stillStarting = await state.findExecutionByBranch("ralph/t1");
  assert.equal(stillStarting?.status, "starting");

  runner.activeLaunches.delete("ralph/t1");

  await runner.recoverTimedOutPrds();
  const recovered = await state.findExecutionByBranch("ralph/t1");
  assert.equal(recovered?.status, "ready");
});

