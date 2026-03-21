#!/usr/bin/env node
// Test script to run Claude SDK outside Claude Code session
// Usage: node scripts/smoke-claude-external.mjs

import { AgentInvocationRouter } from "../dist/agent-sdk/router.js";

async function main() {
  console.log("=== Claude SDK External Test ===\n");

  // Check environment
  if (process.env.CLAUDECODE) {
    console.error("❌ CLAUDECODE env var is set. This test must run outside Claude Code.");
    console.error("   Run: node scripts/smoke-claude-external.mjs");
    process.exit(1);
  }

  const router = new AgentInvocationRouter();

  // Test healthcheck
  console.log("Test 1: Healthcheck");
  const health = await router.healthcheck("claude");
  console.log("Health result:", health);

  if (!health.claude) {
    console.error("❌ Claude backend unhealthy:", health);
    process.exit(1);
  }

  console.log("✅ Claude backend healthy\n");

  // Test invocation
  console.log("Test 2: Claude invocation");
  try {
    const handle = await router.invoke({
      provider: "claude",
      taskKind: "general",
      cwd: process.cwd(),
      prompt: "Say 'hello from external process' and nothing else",
      model: "claude-opus-4-6",
    });

    console.log(`✅ Task started: ${handle.taskId}\n`);

    let eventCount = 0;
    for await (const event of handle.events) {
      eventCount++;
      console.log(
        `Event ${eventCount}: ${event.phase} - ${event.message || event.step || "no message"}`
      );

      if (eventCount > 10) {
        console.log("(truncating event stream for test)");
        break;
      }
    }

    const result = await handle.wait();
    console.log("\n✅ Task completed:", result.status);
    if (result.output) {
      console.log("Output:", result.output.slice(0, 200));
    }
    if (result.error) {
      console.log("Error:", result.error);
    }
  } catch (error) {
    console.error("❌ Invocation failed:", error);
    process.exit(1);
  }

  console.log("\n=== Test complete ===");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
