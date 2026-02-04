import { before, beforeEach, after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

let dataDir;
let state;
let startTool;
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

function git(cwd, command) {
  return execSync(command, { cwd, stdio: "pipe", encoding: "utf-8" }).trim();
}

function initRepo(repoDir) {
  git(repoDir, "git init -b main");
  git(repoDir, "git config user.email \"test@example.com\"");
  git(repoDir, "git config user.name \"Test\"");
  execSync("git add .", { cwd: repoDir, stdio: "ignore" });
  execSync("git commit --allow-empty -m \"init\"", { cwd: repoDir, stdio: "ignore" });
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
  ({ start: startTool } = await import("../dist/tools/start.js"));
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

test("areDependenciesSatisfied treats completed dependency PRD file as satisfied", async () => {
  const projectRoot = join(dataDir, "project");
  const tasksDir = join(projectRoot, "tasks");
  await mkdir(tasksDir, { recursive: true });

  await writeFile(join(tasksDir, "prd-dep.md"), "---\nstatus: completed\n---\n# Dep\n", "utf-8");
  const mainPath = join(tasksDir, "prd-main.md");
  await writeFile(mainPath, "---\nstatus: pending\n---\n# Main\n", "utf-8");

  const depStatus = await state.areDependenciesSatisfied({
    dependencies: ["ralph/prd-dep"],
    projectRoot,
    prdPath: mainPath,
  });

  assert.equal(depStatus.satisfied, true);
  assert.deepEqual(depStatus.pending, []);
  assert.deepEqual(depStatus.completed, ["ralph/prd-dep"]);
});

test("areDependenciesSatisfied uses dependency PRD frontmatter branch for state lookup", async () => {
  const projectRoot = join(dataDir, "project");
  const tasksDir = join(projectRoot, "tasks");
  await mkdir(tasksDir, { recursive: true });

  await writeFile(
    join(tasksDir, "prd-dep.md"),
    "---\nstatus: pending\nbranch: ralph/custom-branch\n---\n# Dep\n",
    "utf-8"
  );

  const mainPath = join(tasksDir, "prd-main.md");
  await writeFile(mainPath, "---\nstatus: pending\n---\n# Main\n", "utf-8");

  await state.insertExecution(
    makeExecution({
      id: "dep",
      branch: "ralph/custom-branch",
      status: "completed",
      projectRoot,
    })
  );

  const depStatus = await state.areDependenciesSatisfied({
    dependencies: ["ralph/prd-dep"],
    projectRoot,
    prdPath: mainPath,
  });

  assert.equal(depStatus.satisfied, true);
  assert.deepEqual(depStatus.pending, []);
  assert.deepEqual(depStatus.completed, ["ralph/prd-dep"]);
});

test("areDependenciesSatisfied uses dependency PRD JSON branchName for state lookup", async () => {
  const projectRoot = join(dataDir, "project");
  const tasksDir = join(projectRoot, "tasks");
  await mkdir(tasksDir, { recursive: true });

  await writeFile(
    join(tasksDir, "prd-dep.json"),
    JSON.stringify({ status: "pending", branchName: "ralph/custom-branch" }, null, 2),
    "utf-8"
  );

  const mainPath = join(tasksDir, "prd-main.md");
  await writeFile(mainPath, "---\nstatus: pending\n---\n# Main\n", "utf-8");

  await state.insertExecution(
    makeExecution({
      id: "dep",
      branch: "ralph/custom-branch",
      status: "completed",
      projectRoot,
    })
  );

  const depStatus = await state.areDependenciesSatisfied({
    dependencies: ["ralph/prd-dep"],
    projectRoot,
    prdPath: mainPath,
  });

  assert.equal(depStatus.satisfied, true);
  assert.deepEqual(depStatus.pending, []);
  assert.deepEqual(depStatus.completed, ["ralph/prd-dep"]);
});

test("areDependenciesSatisfied resolves dependency by PRD id when filename/branch differ", async () => {
  const projectRoot = join(dataDir, "project");
  const tasksDir = join(projectRoot, "tasks");
  await mkdir(tasksDir, { recursive: true });

  // Dependency is referenced as `ralph/prd-subscription-system`, but the PRD file/branch is localized.
  await writeFile(
    join(tasksDir, "prd-zh-subscription.md"),
    ["---", "id: prd-subscription-system", "---", "# prd-subscription-system-cn"].join("\n"),
    "utf-8"
  );

  const mainPath = join(tasksDir, "prd-main.md");
  await writeFile(mainPath, "---\nstatus: pending\n---\n# Main\n", "utf-8");

  await state.insertExecution(
    makeExecution({
      id: "dep",
      branch: "ralph/prd-subscription-system-cn",
      status: "completed",
      projectRoot,
    })
  );

  const depStatus = await state.areDependenciesSatisfied({
    dependencies: ["ralph/prd-subscription-system"],
    projectRoot,
    prdPath: mainPath,
  });

  assert.equal(depStatus.satisfied, true);
  assert.deepEqual(depStatus.pending, []);
  assert.deepEqual(depStatus.completed, ["ralph/prd-subscription-system"]);
});

test("areDependenciesSatisfied treats dependency satisfied if any archived record is completed", async () => {
  const projectRoot = join(dataDir, "project");
  const tasksDir = join(projectRoot, "tasks");
  await mkdir(tasksDir, { recursive: true });

  const mainPath = join(tasksDir, "prd-main.md");
  await writeFile(mainPath, "---\nstatus: pending\n---\n# Main\n", "utf-8");

  const depBranch = "ralph/prd-dep";

  await state.insertExecution(
    makeExecution({
      id: "dep-failed",
      branch: depBranch,
      status: "failed",
      projectRoot,
    })
  );
  await state.archiveExecution("dep-failed");

  await state.insertExecution(
    makeExecution({
      id: "dep-completed",
      branch: depBranch,
      status: "completed",
      projectRoot,
    })
  );
  await state.archiveExecution("dep-completed");

  const depStatus = await state.areDependenciesSatisfied({
    dependencies: [depBranch],
    projectRoot,
    prdPath: mainPath,
  });

  assert.equal(depStatus.satisfied, true);
  assert.deepEqual(depStatus.pending, []);
  assert.deepEqual(depStatus.completed, [depBranch]);
});

test("runner unblocks a queued PRD once dependency PRD file is marked completed", async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "ralph-mcp-repo-"));
  try {
    initRepo(repoDir);

    const tasksDir = join(repoDir, "tasks");
    await mkdir(tasksDir, { recursive: true });

    await writeFile(
      join(tasksDir, "prd-dep.md"),
      ["---", "branch: ralph/prd-dep", "status: pending", "---", "# Dep PRD"].join("\n"),
      "utf-8"
    );

    await writeFile(
      join(tasksDir, "prd-main.md"),
      [
        "---",
        "branch: ralph/prd-main",
        "dependencies:",
        "  - tasks/prd-dep.md",
        "---",
        "# Main PRD",
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

    const startResult = await startTool({
      prdPath: "tasks/prd-main.md",
      projectRoot: repoDir,
      worktree: false,
      autoStart: false,
      queueIfBlocked: true,
    });

    assert.equal(startResult.dependenciesSatisfied, false);
    assert.deepEqual(startResult.pendingDependencies, ["ralph/prd-dep"]);

    const launcher = {
      launch: async (_prompt, _cwd, executionId) => {
        return { success: true, agentTaskId: `agent-${executionId}`, logPath: null };
      },
    };

    const runner = new Runner({ concurrency: 1, onLog: () => {} }, launcher);

    // Mark dependency as completed and let the runner promote pending -> ready.
    await writeFile(
      join(tasksDir, "prd-dep.md"),
      ["---", "branch: ralph/prd-dep", "status: completed", "---", "# Dep PRD"].join("\n"),
      "utf-8"
    );

    await runner.promotePendingPrds();
    const afterPromote = await state.findExecutionByBranch("ralph/prd-main");
    assert.equal(afterPromote?.status, "ready");

    await runner.processReadyPrds();
    await waitUntil(async () => {
      const exec = await state.findExecutionByBranch("ralph/prd-main");
      return exec?.status === "running";
    });

    const exec = await state.findExecutionByBranch("ralph/prd-main");
    assert.equal(exec?.status, "running");
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});
