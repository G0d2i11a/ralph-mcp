import { before, beforeEach, after, test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir;
let state;
let mergeTools;

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

function git(cwd, command) {
  return execSync(command, { cwd, stdio: "pipe", encoding: "utf-8" }).trim();
}

async function initRepoWithFeature() {
  const repoDir = await mkdtemp(join(tmpdir(), "ralph-mcp-merge-repo-"));
  git(repoDir, "git init -b main");
  git(repoDir, "git config user.email \"test@example.com\"");
  git(repoDir, "git config user.name \"Ralph Test\"");

  await writeFile(join(repoDir, "README.md"), "base\n", "utf-8");
  git(repoDir, "git add README.md");
  git(repoDir, "git commit -m \"init\"");

  git(repoDir, "git checkout -b ralph/feature");
  await writeFile(join(repoDir, "feature.txt"), "feature\n", "utf-8");
  git(repoDir, "git add feature.txt");
  git(repoDir, "git commit -m \"feat: feature\"");
  git(repoDir, "git checkout main");

  return repoDir;
}

function makeExecution(overrides = {}) {
  const now = new Date();
  return {
    id: "exec",
    project: "test-project",
    branch: "ralph/feature",
    description: "feature",
    priority: "P1",
    prdPath: "",
    projectRoot: dataDir,
    worktreePath: null,
    baseCommitSha: null,
    status: "completed",
    agentTaskId: null,
    onConflict: "notify",
    autoMerge: true,
    notifyOnComplete: false,
    dependencies: [],
    loopCount: 0,
    consecutiveNoProgress: 0,
    consecutiveErrors: 0,
    lastError: null,
    lastFilesChanged: 0,
    lastProgressAt: now,
    lastCommitCount: null,
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

function makeStory(executionId, overrides = {}) {
  return {
    id: `${executionId}:US-001`,
    executionId,
    storyId: "US-001",
    title: "Feature",
    description: "Implement feature",
    acceptanceCriteria: ["Works"],
    priority: 1,
    passes: true,
    notes: "",
    acEvidence: {},
    ...overrides,
  };
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ralph-mcp-test-"));
  process.env.RALPH_DATA_DIR = dataDir;

  state = await import("../dist/store/state.js");
  mergeTools = await import("../dist/tools/merge.js");
});

beforeEach(async () => {
  await resetStateFiles();
});

after(async () => {
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("claimNextMergeQueueItem serializes merge processing", async () => {
  await state.insertExecution(makeExecution({ id: "a", branch: "ralph/a" }));
  await state.insertExecution(makeExecution({ id: "b", branch: "ralph/b" }));
  await state.insertMergeQueueItem({
    executionId: "a",
    position: 1,
    status: "pending",
    createdAt: new Date(),
  });
  await state.insertMergeQueueItem({
    executionId: "b",
    position: 2,
    status: "pending",
    createdAt: new Date(),
  });

  const first = await state.claimNextMergeQueueItem();
  assert.equal(first.blockedByCurrent, false);
  assert.equal(first.item?.executionId, "a");
  assert.equal(first.item?.status, "merging");

  const second = await state.claimNextMergeQueueItem();
  assert.equal(second.blockedByCurrent, true);
  assert.equal(second.item?.executionId, "a");

  const queue = await state.listMergeQueue();
  assert.equal(queue.find((q) => q.executionId === "b")?.status, "pending");
});

test("mergeQueueAction process does not update an archived queue item after successful merge", async () => {
  const repoDir = await initRepoWithFeature();
  try {
    const execution = makeExecution({
      id: "merge-me",
      branch: "ralph/feature",
      projectRoot: repoDir,
    });
    await state.insertExecution(execution);
    await state.insertUserStories([makeStory(execution.id)]);
    await state.insertMergeQueueItem({
      executionId: execution.id,
      position: 1,
      status: "pending",
      createdAt: new Date(),
    });

    const result = await mergeTools.mergeQueueAction({ action: "process" });
    assert.match(result.message, /Successfully merged ralph\/feature to main/);

    const queue = await state.listMergeQueue();
    assert.equal(queue.length, 0);

    const archived = await state.listArchivedExecutions();
    assert.equal(archived.length, 1);
    assert.equal(archived[0].branch, "ralph/feature");
    assert.equal(archived[0].status, "merged");
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});
