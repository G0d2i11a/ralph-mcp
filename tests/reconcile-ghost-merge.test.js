import { before, beforeEach, after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

let dataDir;
let state;
let statusTool;
let startTool;

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

function initRepo(repoDir) {
  git(repoDir, "git init -b main");
  git(repoDir, "git config user.email \"test@example.com\"");
  git(repoDir, "git config user.name \"Test\"");
  writeFileSync(join(repoDir, "README.md"), "hi\n");
  git(repoDir, "git add .");
  git(repoDir, "git commit -m \"init\"");
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
    status: "pending",
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
  ({ status: statusTool } = await import("../dist/tools/status.js"));
  ({ start: startTool } = await import("../dist/tools/start.js"));
});

beforeEach(async () => {
  await resetStateFiles();
});

after(async () => {
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("status reconcile does not ghost-merge a fresh branch with no commits", async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "ralph-mcp-repo-"));
  try {
    initRepo(repoDir);
    git(repoDir, "git branch \"ralph/prd-test\"");
    const baseCommitSha = git(repoDir, "git rev-parse \"ralph/prd-test\"");

    await state.insertExecution(
      makeExecution({
        id: "e1",
        branch: "ralph/prd-test",
        projectRoot: repoDir,
        status: "pending",
        baseCommitSha,
      })
    );

    await statusTool({});

    const execs = await state.listExecutions();
    assert.equal(execs.length, 1);
    assert.equal(execs[0].status, "pending");
    assert.equal(execs[0].branch, "ralph/prd-test");

    const archived = await state.listArchivedExecutions();
    assert.equal(archived.length, 0);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("status reconcile archives a merged branch once it has diverged since start", async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "ralph-mcp-repo-"));
  const worktreeDir = join(repoDir, "wt");

  try {
    initRepo(repoDir);

    // Create a worktree branch (typical Ralph flow)
    git(repoDir, `git worktree add -b \"ralph/prd-merged\" \"${worktreeDir}\" main`);

    const baseCommitSha = git(worktreeDir, "git rev-parse HEAD");

    await state.insertExecution(
      makeExecution({
        id: "e2",
        branch: "ralph/prd-merged",
        projectRoot: repoDir,
        worktreePath: worktreeDir,
        status: "running",
        baseCommitSha,
        createdAt: new Date(Date.now() - 10 * 60 * 1000),
        updatedAt: new Date(Date.now() - 10 * 60 * 1000),
      })
    );

    // Make a commit on the branch worktree
    writeFileSync(join(worktreeDir, "feature.txt"), "feature\n");
    git(worktreeDir, "git add .");
    git(worktreeDir, "git commit -m \"feat: work\"");

    // Merge into main
    git(repoDir, "git checkout main");
    git(repoDir, "git merge --no-ff \"ralph/prd-merged\" -m \"merge\"");

    await statusTool({});

    const execs = await state.listExecutions();
    assert.equal(execs.length, 0);

    const archived = await state.listArchivedExecutions();
    assert.equal(archived.length, 1);
    assert.equal(archived[0].branch, "ralph/prd-merged");
    assert.equal(archived[0].status, "merged");
    assert.equal(archived[0].reconcileReason, "branch_merged");

    // Ensure cleanup used correct args and removed the worktree directory
    assert.equal(existsSync(worktreeDir), false);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("ralph_start writes baseCommitSha at creation time (worktree=true)", async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "ralph-mcp-repo-"));
  try {
    initRepo(repoDir);
    const prdPath = join(repoDir, "prd.md");
    writeFileSync(
      prdPath,
      [
        "---",
        "branch: ralph/prd-start",
        "---",
        "# PRD start",
        "",
        "## Description",
        "Test",
        "",
        "## User Stories",
        "### US-001: Dummy",
        "As a user, I want dummy, so that test.",
        "",
        "**Acceptance Criteria:**",
        "- [ ] AC1",
        "",
      ].join("\n"),
      "utf-8"
    );

    await startTool({ prdPath: "prd.md", projectRoot: repoDir, worktree: true, autoStart: false });

    const execs = await state.listExecutions();
    assert.equal(execs.length, 1);
    assert.equal(execs[0].branch, "ralph/prd-start");
    assert.equal(typeof execs[0].baseCommitSha, "string");
    assert.equal(execs[0].baseCommitSha, git(repoDir, "git rev-parse \"ralph/prd-start\""));
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("ralph_start writes baseCommitSha at creation time (worktree=false)", async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "ralph-mcp-repo-"));
  try {
    initRepo(repoDir);
    const prdPath = join(repoDir, "prd.md");
    writeFileSync(
      prdPath,
      [
        "---",
        "branch: ralph/prd-start-no-wt",
        "---",
        "# PRD start",
        "",
        "## Description",
        "Test",
        "",
      ].join("\n"),
      "utf-8"
    );

    await startTool({ prdPath: "prd.md", projectRoot: repoDir, worktree: false, autoStart: false });

    const execs = await state.listExecutions();
    assert.equal(execs.length, 1);
    assert.equal(execs[0].branch, "ralph/prd-start-no-wt");
    assert.equal(typeof execs[0].baseCommitSha, "string");
    assert.equal(execs[0].baseCommitSha, git(repoDir, "git rev-parse \"ralph/prd-start-no-wt\""));
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});
