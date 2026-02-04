import { before, beforeEach, after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

let dataDir;
let state;
let statusTool;

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

function git(cwd, command, env = {}) {
  return execSync(command, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();
}

async function initRepo(repoDir) {
  git(repoDir, "git init -b main");
  git(repoDir, "git config user.email \"test@example.com\"");
  git(repoDir, "git config user.name \"Test\"");
  await writeFile(join(repoDir, "README.md"), "# test\n", "utf-8");
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
    projectRoot: "unknown",
    worktreePath: null,
    baseCommitSha: null,
    status: "running",
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
    lastProgressAt: now,
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
  statusTool = await import("../dist/tools/status.js");
});

beforeEach(async () => {
  await resetStateFiles();
});

after(async () => {
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("reconcile does not interrupt when git commits are recent", async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "ralph-mcp-repo-"));
  try {
    await initRepo(repoDir);
    const baseSha = git(repoDir, "git rev-parse HEAD");

    git(repoDir, "git checkout -b ralph/t1");
    await writeFile(join(repoDir, "work.txt"), "work\n", "utf-8");
    git(repoDir, "git add .");
    git(repoDir, "git commit -m \"feat: work\"");

    const now = Date.now();
    await state.insertExecution(
      makeExecution({
        id: "t1",
        branch: "ralph/t1",
        projectRoot: repoDir,
        worktreePath: repoDir,
        baseCommitSha: baseSha,
        status: "running",
        updatedAt: new Date(now - 2 * 60 * 60 * 1000),
      })
    );

    await statusTool.status({ reconcile: true, historyLimit: 0 });
    const exec = await state.findExecutionByBranch("ralph/t1");
    assert.equal(exec?.status, "running");
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("adaptive timeout keeps building tasks running at 45m idle", async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "ralph-mcp-repo-"));
  try {
    await initRepo(repoDir);
    const baseSha = git(repoDir, "git rev-parse HEAD");

    const commitDate = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    git(repoDir, "git checkout -b ralph/building");
    await writeFile(join(repoDir, "build.txt"), "build\n", "utf-8");
    git(repoDir, "git add .");
    git(repoDir, "git commit -m \"build: run build\"",
      {
        GIT_AUTHOR_DATE: commitDate,
        GIT_COMMITTER_DATE: commitDate,
      }
    );

    const now = Date.now();
    await state.insertExecution(
      makeExecution({
        id: "b1",
        branch: "ralph/building",
        projectRoot: repoDir,
        worktreePath: repoDir,
        baseCommitSha: baseSha,
        status: "running",
        currentStep: "building",
        updatedAt: new Date(now - 2 * 60 * 60 * 1000),
      })
    );

    await statusTool.status({ reconcile: true, historyLimit: 0 });
    const exec = await state.findExecutionByBranch("ralph/building");
    assert.equal(exec?.status, "running");
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("adaptive timeout interrupts implementing tasks at 45m idle", async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "ralph-mcp-repo-"));
  try {
    await initRepo(repoDir);
    const baseSha = git(repoDir, "git rev-parse HEAD");

    const commitDate = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    git(repoDir, "git checkout -b ralph/implementing");
    await writeFile(join(repoDir, "impl.txt"), "impl\n", "utf-8");
    git(repoDir, "git add .");
    git(repoDir, "git commit -m \"feat: impl\"",
      {
        GIT_AUTHOR_DATE: commitDate,
        GIT_COMMITTER_DATE: commitDate,
      }
    );

    const now = Date.now();
    await state.insertExecution(
      makeExecution({
        id: "i1",
        branch: "ralph/implementing",
        projectRoot: repoDir,
        worktreePath: repoDir,
        baseCommitSha: baseSha,
        status: "running",
        currentStep: "implementing",
        updatedAt: new Date(now - 2 * 60 * 60 * 1000),
      })
    );

    await statusTool.status({ reconcile: true, historyLimit: 0 });
    const exec = await state.findExecutionByBranch("ralph/implementing");
    assert.equal(exec?.status, "interrupted");
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("log mtime prevents interrupt even when state is stale", async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "ralph-mcp-repo-"));
  try {
    await initRepo(repoDir);
    const baseSha = git(repoDir, "git rev-parse HEAD");

    git(repoDir, "git checkout -b ralph/log-active");
    await writeFile(join(repoDir, "noop.txt"), "noop\n", "utf-8");
    git(repoDir, "git add .");
    git(repoDir, "git commit -m \"chore: noop\"");

    const logPath = join(dataDir, "agent.jsonl");
    await writeFile(logPath, "{\"type\":\"assistant\",\"text\":\"running pnpm test\"}\n", "utf-8");
    const nowDate = new Date();
    await utimes(logPath, nowDate, nowDate);

    const now = Date.now();
    await state.insertExecution(
      makeExecution({
        id: "l1",
        branch: "ralph/log-active",
        projectRoot: repoDir,
        worktreePath: repoDir,
        baseCommitSha: baseSha,
        status: "running",
        currentStep: "implementing",
        logPath,
        updatedAt: new Date(now - 2 * 60 * 60 * 1000),
      })
    );

    await statusTool.status({ reconcile: true, historyLimit: 0 });
    const exec = await state.findExecutionByBranch("ralph/log-active");
    assert.equal(exec?.status, "running");
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("recordLoopResult respects no-progress timeout", async () => {
  const now = new Date();
  const execId = "loop1";
  const branch = "ralph/loop1";

  await state.insertExecution(
    makeExecution({
      id: execId,
      branch,
      status: "running",
      consecutiveNoProgress: 2,
      lastProgressAt: new Date(now.getTime() - 5 * 60 * 1000),
    })
  );

  const res = await state.recordLoopResult(execId, 0, null, {
    now,
    thresholds: { noProgressThreshold: 3, sameErrorThreshold: 5 },
    noProgressTimeoutMs: 30 * 60 * 1000,
    progressSignals: {},
  });

  assert.equal(res.isStagnant, false);
  const exec = await state.findExecutionByBranch(branch);
  assert.equal(exec?.status, "running");
});

test("recordLoopResult marks failed when no-progress timeout is exceeded", async () => {
  const now = new Date();
  const execId = "loop2";
  const branch = "ralph/loop2";

  await state.insertExecution(
    makeExecution({
      id: execId,
      branch,
      status: "running",
      consecutiveNoProgress: 2,
      lastProgressAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
    })
  );

  const res = await state.recordLoopResult(execId, 0, null, {
    now,
    thresholds: { noProgressThreshold: 3, sameErrorThreshold: 5 },
    noProgressTimeoutMs: 30 * 60 * 1000,
    progressSignals: {},
  });

  assert.equal(res.isStagnant, true);
  assert.equal(res.type, "no_progress");
  const exec = await state.findExecutionByBranch(branch);
  assert.equal(exec?.status, "failed");
});

