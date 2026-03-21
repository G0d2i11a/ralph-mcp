import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

let dataDir;
let docsDir;
let repoDir;
let watcherStatePath;
let state;
let PrdIngestionWatcher;
let resolvePrdWatchOptions;
let DEFAULT_CONFIG;

const prdWatchEnvKeys = [
  "RALPH_PRD_WATCH_ENABLED",
  "RALPH_PRD_WATCH_DIR",
  "RALPH_PRD_WATCH_PATTERN",
  "RALPH_PRD_WATCH_PROJECT_ROOT",
  "RALPH_PRD_WATCH_STATE_PATH",
  "RALPH_PRD_WATCH_SCAN_INTERVAL_MS",
  "RALPH_PRD_WATCH_SETTLE_MS",
  "RALPH_PRD_WATCH_WORKTREE",
];

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function createRepo() {
  const dir = await mkdtemp(join(tmpdir(), "ralph-mcp-watch-repo-"));
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Ralph Test"]);

  await writeFile(join(dir, "README.md"), "test\n", "utf-8");
  await git(dir, ["add", "README.md"]);
  await git(dir, ["commit", "-m", "init"]);
  await git(dir, ["branch", "-M", "main"]);

  return dir;
}

function prdJson({ repo, branch, dependencies = [], description = "Test PRD" }) {
  return JSON.stringify(
    {
      project: "ez4ielts",
      projectName: branch.replace("ralph/", ""),
      description,
      repository: repo,
      branchName: branch,
      dependencies,
      userStories: [
        {
          id: "US-001",
          title: "Do thing",
          description: "Implement something useful",
          acceptanceCriteria: ["Works"],
          priority: 1,
        },
      ],
    },
    null,
    2
  );
}

async function resetStateFiles() {
  await rm(join(dataDir, "state.json"), { force: true });
  await rm(join(dataDir, "state.lock"), { force: true });
  await rm(watcherStatePath, { force: true });

  const entries = await readdir(dataDir);
  await Promise.all(
    entries
      .filter((name) => name.startsWith("state.json.backup-"))
      .map((name) => rm(join(dataDir, name), { force: true }))
  );
}

async function waitFor(check, timeoutMs = 3000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("Timed out waiting for condition");
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ralph-mcp-watch-data-"));
  process.env.RALPH_DATA_DIR = dataDir;

  state = await import("../dist/store/state.js");
  ({ PrdIngestionWatcher } = await import("../dist/watchers/prd-ingestion-watcher.js"));
  ({ resolvePrdWatchOptions } = await import("../dist/runner-cli.js"));
  ({ DEFAULT_CONFIG } = await import("../dist/config/schema.js"));
});

beforeEach(async () => {
  watcherStatePath = join(dataDir, "watcher-state.json");
  for (const key of prdWatchEnvKeys) {
    delete process.env[key];
  }
  await resetStateFiles();
  repoDir = await createRepo();
  docsDir = await mkdtemp(join(tmpdir(), "ralph-mcp-watch-docs-"));
});

afterEach(async () => {
  if (repoDir) {
    await rm(repoDir, { recursive: true, force: true });
    repoDir = null;
  }

  if (docsDir) {
    await rm(docsDir, { recursive: true, force: true });
    docsDir = null;
  }
});

after(async () => {
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("watcher bootstraps existing files and only ingests newly seen PRDs", async () => {
  await writeFile(
    join(docsDir, "ez4ielts-existing-prd.json"),
    prdJson({ repo: repoDir, branch: "ralph/existing-prd" }),
    "utf-8"
  );

  const watcher = new PrdIngestionWatcher({
    watchDir: docsDir,
    filePattern: "^ez4ielts-.*\\.json$",
    statePath: watcherStatePath,
    settleMs: 25,
    scanIntervalMs: 60_000,
    worktree: false,
    onLog: () => {},
  });

  try {
    await watcher.start();

    const bootstrapped = await state.findExecutionByBranch("ralph/existing-prd");
    assert.equal(bootstrapped, null);

    const newPrdPath = join(docsDir, "ez4ielts-new-prd.json");
    await writeFile(
      newPrdPath,
      prdJson({ repo: repoDir, branch: "ralph/new-prd" }),
      "utf-8"
    );

    await watcher.scanNow();

    const execution = await waitFor(() => state.findExecutionByBranch("ralph/new-prd"));
    assert.ok(execution);
    assert.equal(execution.status, "ready");

    await writeFile(
      newPrdPath,
      prdJson({ repo: repoDir, branch: "ralph/new-prd", description: "Updated PRD" }),
      "utf-8"
    );
    await watcher.scanNow();
    await new Promise((resolve) => setTimeout(resolve, 350));

    const executions = await state.listExecutions();
    assert.equal(executions.filter((item) => item.branch === "ralph/new-prd").length, 1);
  } finally {
    watcher.stop();
  }
});

test("watcher creates pending executions for blocked dependencies", async () => {
  const watcher = new PrdIngestionWatcher({
    watchDir: docsDir,
    filePattern: "^ez4ielts-.*\\.json$",
    statePath: watcherStatePath,
    settleMs: 25,
    scanIntervalMs: 60_000,
    worktree: false,
    onLog: () => {},
  });

  try {
    await watcher.start();

    await writeFile(
      join(docsDir, "ez4ielts-blocked-prd.json"),
      prdJson({
        repo: repoDir,
        branch: "ralph/blocked-prd",
        dependencies: ["ralph/missing-dependency"],
      }),
      "utf-8"
    );

    await watcher.scanNow();

    const execution = await waitFor(() => state.findExecutionByBranch("ralph/blocked-prd"));
    assert.ok(execution);
    assert.equal(execution.status, "pending");
  } finally {
    watcher.stop();
  }
});

test("watcher requires an explicit watch directory", () => {
  assert.throws(
    () => {
      new PrdIngestionWatcher({
        statePath: watcherStatePath,
        onLog: () => {},
      });
    },
    /explicit watch directory/
  );
});

test("runner-cli resolves PRD watcher options from config and CLI overrides", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.watchers.prdIngestion.enabled = true;
  config.watchers.prdIngestion.watchDir = docsDir;
  config.watchers.prdIngestion.projectRoot = repoDir;
  config.watchers.prdIngestion.worktree = false;

  const resolvedFromConfig = resolvePrdWatchOptions(
    {
      interval: 5000,
      concurrency: 0,
      maxRetries: 3,
      timeout: 60000,
    },
    config
  );

  assert.ok(resolvedFromConfig);
  assert.equal(resolvedFromConfig.watchDir, docsDir);
  assert.equal(resolvedFromConfig.projectRoot, repoDir);
  assert.equal(resolvedFromConfig.worktree, false);

  const resolvedFromCli = resolvePrdWatchOptions(
    {
      interval: 5000,
      concurrency: 0,
      maxRetries: 3,
      timeout: 60000,
      watchPrds: true,
      watchPrdsDir: join(docsDir, "override"),
      watchPrdsProjectRoot: join(repoDir, "override"),
      watchPrdsWorktree: true,
    },
    config
  );

  assert.ok(resolvedFromCli);
  assert.equal(resolvedFromCli.watchDir, join(docsDir, "override"));
  assert.equal(resolvedFromCli.projectRoot, join(repoDir, "override"));
  assert.equal(resolvedFromCli.worktree, true);
});

test("runner-cli fails fast when watch mode is enabled without a directory", () => {
  const config = structuredClone(DEFAULT_CONFIG);

  assert.throws(
    () => {
      resolvePrdWatchOptions(
        {
          interval: 5000,
          concurrency: 0,
          maxRetries: 3,
          timeout: 60000,
          watchPrds: true,
        },
        config
      );
    },
    /explicit watch directory/
  );
});
