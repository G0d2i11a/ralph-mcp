import { before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let SdkLauncher;
let createLauncher;

before(async () => {
  ({ SdkLauncher } = await import("../dist/utils/sdk-launcher.js"));
  ({ createLauncher } = await import("../dist/utils/launcher.js"));
});

function makeHandle(taskId = "task-1") {
  return {
    taskId,
    logPath: "/tmp/test.jsonl",
    events: (async function* () {})(),
    wait: async () => ({
      taskId,
      provider: "codex",
      status: "success",
    }),
  };
}

test("sdk launcher defaults to codex when no config overrides are present", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-sdk-default-"));
  const launcher = new SdkLauncher({ onLog: () => {} });
  let captured;

  launcher.router = {
    invoke: async (req) => {
      captured = req;
      return makeHandle();
    },
  };

  const result = await launcher.launch("test prompt", cwd, "exec-default");

  assert.equal(result.success, true);
  assert.equal(captured?.provider, "codex");
});

test("sdk launcher honors project provider config for claude", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-sdk-claude-"));
  await writeFile(
    join(cwd, ".ralph.yaml"),
    [
      "agent:",
      "  provider: claude",
      "",
    ].join("\n"),
    "utf8"
  );

  const launcher = new SdkLauncher({ onLog: () => {} });
  let captured;

  launcher.router = {
    invoke: async (req) => {
      captured = req;
      return makeHandle("task-2");
    },
  };

  const result = await launcher.launch("test prompt", cwd, "exec-claude");

  assert.equal(result.success, true);
  assert.equal(captured?.provider, "claude");
});

test("multi-backend launcher defaults to codex CLI", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-launcher-cli-default-"));
  const calls = [];

  const launcher = createLauncher(
    { onLog: () => {} },
    {
      createCodexCliLauncher: () => ({
        launch: async () => {
          calls.push("codex-cli");
          return { success: true, agentTaskId: "cli-codex-1" };
        },
      }),
      createClaudeCliLauncher: () => ({
        launch: async () => {
          calls.push("claude-cli");
          return { success: true, agentTaskId: "cli-claude-1" };
        },
      }),
      createSdkFallbackLauncher: () => ({
        launch: async () => {
          calls.push("sdk");
          return { success: true, agentTaskId: "sdk-1" };
        },
      }),
    }
  );

  const result = await launcher.launch("test prompt", cwd, "exec-cli-default");

  assert.equal(result.success, true);
  assert.equal(result.agentTaskId, "cli-codex-1");
  assert.deepEqual(calls, ["codex-cli"]);
});

test("multi-backend launcher honors claude provider for CLI backend", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-launcher-claude-cli-"));
  await writeFile(
    join(cwd, ".ralph.yaml"),
    [
      "agent:",
      "  backend: cli",
      "  provider: claude",
      "",
    ].join("\n"),
    "utf8"
  );

  const calls = [];
  const launcher = createLauncher(
    { onLog: () => {} },
    {
      createCodexCliLauncher: () => ({
        launch: async () => {
          calls.push("codex-cli");
          return { success: true, agentTaskId: "cli-codex-1" };
        },
      }),
      createClaudeCliLauncher: () => ({
        launch: async () => {
          calls.push("claude-cli");
          return { success: true, agentTaskId: "cli-claude-1" };
        },
      }),
      createSdkFallbackLauncher: () => ({
        launch: async () => {
          calls.push("sdk");
          return { success: true, agentTaskId: "sdk-1" };
        },
      }),
    }
  );

  const result = await launcher.launch("test prompt", cwd, "exec-claude-cli");

  assert.equal(result.success, true);
  assert.equal(result.agentTaskId, "cli-claude-1");
  assert.deepEqual(calls, ["claude-cli"]);
});

test("multi-backend launcher honors sdk backend override", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-launcher-sdk-override-"));
  await writeFile(
    join(cwd, ".ralph.yaml"),
    [
      "agent:",
      "  backend: sdk",
      "  provider: claude",
      "",
    ].join("\n"),
    "utf8"
  );

  const calls = [];
  const launcher = createLauncher(
    { onLog: () => {} },
    {
      createCodexCliLauncher: () => ({
        launch: async () => {
          calls.push("codex-cli");
          return { success: true, agentTaskId: "cli-codex-1" };
        },
      }),
      createClaudeCliLauncher: () => ({
        launch: async () => {
          calls.push("claude-cli");
          return { success: true, agentTaskId: "cli-claude-1" };
        },
      }),
      createSdkFallbackLauncher: () => ({
        launch: async () => {
          calls.push("sdk");
          return { success: true, agentTaskId: "sdk-1" };
        },
      }),
    }
  );

  const result = await launcher.launch("test prompt", cwd, "exec-sdk-override");

  assert.equal(result.success, true);
  assert.equal(result.agentTaskId, "sdk-1");
  assert.deepEqual(calls, ["sdk"]);
});

test("multi-backend launcher falls back to sdk when CLI launch fails", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-launcher-fallback-"));
  const calls = [];

  const launcher = createLauncher(
    { onLog: () => {} },
    {
      createCodexCliLauncher: () => ({
        launch: async () => {
          calls.push("codex-cli");
          return { success: false, error: "codex CLI unavailable" };
        },
      }),
      createClaudeCliLauncher: () => ({
        launch: async () => {
          calls.push("claude-cli");
          return { success: true, agentTaskId: "cli-claude-1" };
        },
      }),
      createSdkFallbackLauncher: () => ({
        launch: async () => {
          calls.push("sdk");
          return { success: true, agentTaskId: "sdk-fallback-1" };
        },
      }),
    }
  );

  const result = await launcher.launch("test prompt", cwd, "exec-sdk-fallback");

  assert.equal(result.success, true);
  assert.equal(result.agentTaskId, "sdk-fallback-1");
  assert.deepEqual(calls, ["codex-cli", "sdk"]);
});
