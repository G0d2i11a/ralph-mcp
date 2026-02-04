import { before, beforeEach, afterEach, after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

let dataDir;
let repoDir;
let state;
let start;
let startInputSchema;
let batchStart;
let batchStartInputSchema;

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

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function createRepo() {
  const dir = await mkdtemp(join(tmpdir(), "ralph-mcp-start-repo-"));
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Ralph Test"]);

  await writeFile(join(dir, "README.md"), "test\n", "utf-8");
  await git(dir, ["add", "README.md"]);
  await git(dir, ["commit", "-m", "init"]);
  await git(dir, ["branch", "-M", "main"]);

  await mkdir(join(dir, "tasks"), { recursive: true });
  return dir;
}

function prdMarkdown({ branch, dependencies = [] }) {
  const depsLine = dependencies.length ? `dependencies: [${dependencies.join(", ")}]\n` : "";
  return `---\nbranch: ${branch}\n${depsLine}---\n# ${branch}\n\n## Description\nTest PRD\n\n## User Stories\n### US-001: Do thing\nAs a user, I want x, so that y.\n\n- AC-1: Works\n`;
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ralph-mcp-test-"));
  process.env.RALPH_DATA_DIR = dataDir;

  state = await import("../dist/store/state.js");
  ({ start, startInputSchema } = await import("../dist/tools/start.js"));
  ({ batchStart, batchStartInputSchema } = await import("../dist/tools/batch-start.js"));
});

beforeEach(async () => {
  await resetStateFiles();
  repoDir = await createRepo();
});

afterEach(async () => {
  process.env.RALPH_AUTO_RUNNER = "";
  if (repoDir) {
    await rm(repoDir, { recursive: true, force: true });
    repoDir = null;
  }
});

after(async () => {
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("ralph_start suppresses agentPrompt when Runner enabled", async () => {
  process.env.RALPH_AUTO_RUNNER = "true";

  const prdPath = join(repoDir, "tasks", "prd-a.md");
  await writeFile(prdPath, prdMarkdown({ branch: "ralph/prd-a" }), "utf-8");

  const result = await start(startInputSchema.parse({
    prdPath: "tasks/prd-a.md",
    projectRoot: repoDir,
    worktree: false,
  }));

  assert.equal(result.agentPrompt, null);

  const exec = await state.findExecutionByBranch("ralph/prd-a");
  assert.ok(exec);
  assert.equal(exec.status, "ready");
});

test("ralph_start returns agentPrompt when Runner disabled", async () => {
  process.env.RALPH_AUTO_RUNNER = "false";

  const prdPath = join(repoDir, "tasks", "prd-a.md");
  await writeFile(prdPath, prdMarkdown({ branch: "ralph/prd-a" }), "utf-8");

  const result = await start(startInputSchema.parse({
    prdPath: "tasks/prd-a.md",
    projectRoot: repoDir,
    worktree: false,
  }));

  assert.ok(typeof result.agentPrompt === "string" && result.agentPrompt.length > 0);

  const exec = await state.findExecutionByBranch("ralph/prd-a");
  assert.ok(exec);
  assert.equal(exec.status, "starting");
  assert.equal(exec.launchAttempts, 1);
  assert.ok(exec.launchAttemptAt instanceof Date);
});

test("ralph_batch_start queues ready PRDs without prompts when Runner enabled", async () => {
  process.env.RALPH_AUTO_RUNNER = "true";

  await writeFile(
    join(repoDir, "tasks", "prd-a.md"),
    prdMarkdown({ branch: "ralph/prd-a" }),
    "utf-8"
  );
  await writeFile(
    join(repoDir, "tasks", "prd-b.md"),
    prdMarkdown({ branch: "ralph/prd-b", dependencies: ["ralph/prd-a"] }),
    "utf-8"
  );

  const result = await batchStart(batchStartInputSchema.parse({
    prdPaths: ["tasks/prd-a.md", "tasks/prd-b.md"],
    projectRoot: repoDir,
    worktree: false,
    preheat: false,
  }));

  assert.equal(result.readyToStart.length, 1);
  assert.equal(result.readyToStart[0].branch, "ralph/prd-a");
  assert.equal(result.readyToStart[0].agentPrompt, null);

  assert.equal(result.waitingForDependencies.length, 1);
  assert.equal(result.waitingForDependencies[0].branch, "ralph/prd-b");
  assert.ok(result.waitingForDependencies[0].pendingDependencies.includes("ralph/prd-a"));

  const execA = await state.findExecutionByBranch("ralph/prd-a");
  const execB = await state.findExecutionByBranch("ralph/prd-b");
  assert.ok(execA);
  assert.ok(execB);
  assert.equal(execA.status, "ready");
  assert.equal(execB.status, "pending");
});

test("ralph_batch_start returns prompts and marks running when Runner disabled (legacy)", async () => {
  process.env.RALPH_AUTO_RUNNER = "false";

  await writeFile(
    join(repoDir, "tasks", "prd-a.md"),
    prdMarkdown({ branch: "ralph/prd-a" }),
    "utf-8"
  );

  const result = await batchStart(batchStartInputSchema.parse({
    prdPaths: ["tasks/prd-a.md"],
    projectRoot: repoDir,
    worktree: false,
    preheat: false,
  }));

  assert.equal(result.readyToStart.length, 1);
  assert.ok(typeof result.readyToStart[0].agentPrompt === "string" && result.readyToStart[0].agentPrompt.length > 0);

  const execA = await state.findExecutionByBranch("ralph/prd-a");
  assert.ok(execA);
  assert.equal(execA.status, "running");
});
