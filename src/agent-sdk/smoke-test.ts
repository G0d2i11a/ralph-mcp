#!/usr/bin/env node
// Smoke test for agent SDK invocation layer
import { AgentInvocationRouter } from "./router.js";

async function main() {
  console.log("=== Agent SDK Smoke Test ===\n");

  const router = new AgentInvocationRouter();

  // Test 1: Healthcheck
  console.log("Test 1: Healthcheck all providers");
  try {
    const health = await router.healthcheck();
    console.log("Health results:", health);

    if (health.claude) {
      console.log("✅ Claude backend healthy");
    } else {
      console.log("❌ Claude backend unhealthy (expected if SDK not installed)");
    }

    if (health.codex) {
      console.log("✅ Codex backend healthy");
    } else {
      console.log("❌ Codex backend unhealthy (expected if SDK not installed)");
    }
  } catch (error) {
    console.error("❌ Healthcheck failed:", error);
  }

  // Test 2: Claude invocation (if healthy)
  console.log("\nTest 2: Claude invocation");
  try {
    const handle = await router.invoke({
      provider: "claude",
      taskKind: "general",
      cwd: process.cwd(),
      prompt: "Say 'hello' and nothing else",
      model: "claude-opus-4-6",
    });

    console.log(`✅ Task started: ${handle.taskId}`);

    let eventCount = 0;
    for await (const event of handle.events) {
      eventCount++;
      console.log(`Event ${eventCount}: ${event.phase} - ${event.message || event.step || "no message"}`);

      if (eventCount > 10) {
        console.log("(truncating event stream for smoke test)");
        break;
      }
    }

    const result = await handle.wait();
    console.log("✅ Task completed:", result.status);
    if (result.output) {
      console.log("Output:", result.output.slice(0, 100));
    }
    if (result.error) {
      console.log("Error:", result.error);
    }
  } catch (error) {
    const err = error as Error;
    if (err.message.includes("not available") || err.message.includes("Cannot find")) {
      console.log("❌ Claude SDK not available (expected):", err.message);
    } else {
      console.error("❌ Unexpected error:", err);
      process.exit(1);
    }
  }

  console.log("\n=== Smoke test complete ===");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
