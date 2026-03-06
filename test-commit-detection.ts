#!/usr/bin/env tsx
/**
 * Test script to verify commit count detection prevents false stagnation.
 * 
 * This test simulates three scenarios:
 * 1. New commit made (should detect progress)
 * 2. Working tree changes (should detect progress)
 * 3. No changes at all (should detect stagnation after threshold)
 */

import { execSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getGitHeadInfo } from "./src/utils/stale-detection.js";
import { 
  insertExecutionAtomic, 
  recordLoopResult, 
  deleteExecution,
  type ExecutionRecord,
  type UserStoryRecord 
} from "./src/store/state.js";

async function setupTestRepo(): Promise<string> {
  const testDir = mkdtempSync(join(tmpdir(), "ralph-test-"));
  
  execSync("git init", { cwd: testDir });
  execSync('git config user.email "test@example.com"', { cwd: testDir });
  execSync('git config user.name "Test User"', { cwd: testDir });
  
  writeFileSync(join(testDir, "README.md"), "# Test Repo\n");
  execSync("git add .", { cwd: testDir });
  execSync('git commit -m "Initial commit"', { cwd: testDir });
  
  return testDir;
}

async function runTest() {
  console.log("🧪 Testing commit count detection for stagnation prevention\n");
  
  const testDir = await setupTestRepo();
  console.log(`✓ Created test repo: ${testDir}`);
  
  try {
    // Create a test execution
    const execution: ExecutionRecord = {
      id: "test-exec-1",
      project: "test-project",
      branch: "ralph/test-branch",
      description: "Test execution",
      priority: "P1",
      prdPath: "test.md",
      projectRoot: testDir,
      worktreePath: testDir,
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
      lastProgressAt: null,
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
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    
    const story: UserStoryRecord = {
      id: "test-exec-1:US-001",
      executionId: "test-exec-1",
      storyId: "US-001",
      title: "Test Story",
      description: "Test",
      acceptanceCriteria: ["AC1"],
      priority: 1,
      passes: false,
      notes: "",
      acEvidence: {},
    };
    
    await insertExecutionAtomic(execution, [story]);
    console.log("✓ Created test execution\n");
    
    // Scenario 1: New commit (should detect progress)
    console.log("📝 Scenario 1: New commit made");
    const gitInfo1 = await getGitHeadInfo(testDir);
    console.log(`  Initial commit count: ${gitInfo1.commitCount}`);
    
    const result1 = await recordLoopResult(execution.id, 0, null, {
      progressSignals: {
        gitHeadCommitMs: gitInfo1.commitMs,
        gitHeadCommitCount: gitInfo1.commitCount,
      },
    });
    
    console.log(`  Loop 1: consecutiveNoProgress=${result1.metrics.consecutiveNoProgress}, isStagnant=${result1.isStagnant}`);
    
    // Make a new commit
    writeFileSync(join(testDir, "file1.txt"), "content 1\n");
    execSync("git add .", { cwd: testDir });
    execSync('git commit -m "Add file1"', { cwd: testDir });
    
    const gitInfo2 = await getGitHeadInfo(testDir);
    console.log(`  New commit count: ${gitInfo2.commitCount}`);
    
    const result2 = await recordLoopResult(execution.id, 0, null, {
      progressSignals: {
        gitHeadCommitMs: gitInfo2.commitMs,
        gitHeadCommitCount: gitInfo2.commitCount,
      },
    });
    
    console.log(`  Loop 2: consecutiveNoProgress=${result2.metrics.consecutiveNoProgress}, isStagnant=${result2.isStagnant}`);
    
    if (result2.metrics.consecutiveNoProgress === 0) {
      console.log("  ✅ PASS: New commit detected as progress\n");
    } else {
      console.log("  ❌ FAIL: New commit NOT detected as progress\n");
    }
    
    // Scenario 2: Working tree changes (should detect progress)
    console.log("📝 Scenario 2: Working tree changes");
    writeFileSync(join(testDir, "file2.txt"), "content 2\n");
    
    const result3 = await recordLoopResult(execution.id, 1, null, {
      progressSignals: {
        gitHeadCommitMs: gitInfo2.commitMs,
        gitHeadCommitCount: gitInfo2.commitCount,
      },
    });
    
    console.log(`  Loop 3: consecutiveNoProgress=${result3.metrics.consecutiveNoProgress}, isStagnant=${result3.isStagnant}`);
    
    if (result3.metrics.consecutiveNoProgress === 0) {
      console.log("  ✅ PASS: Working tree changes detected as progress\n");
    } else {
      console.log("  ❌ FAIL: Working tree changes NOT detected as progress\n");
    }
    
    // Scenario 3: No changes (should increment consecutiveNoProgress)
    console.log("📝 Scenario 3: No changes at all");
    execSync("git add .", { cwd: testDir });
    execSync('git commit -m "Add file2"', { cwd: testDir });
    
    const gitInfo3 = await getGitHeadInfo(testDir);
    
    for (let i = 1; i <= 4; i++) {
      const result = await recordLoopResult(execution.id, 0, null, {
        progressSignals: {
          gitHeadCommitMs: gitInfo3.commitMs,
          gitHeadCommitCount: gitInfo3.commitCount,
        },
      });
      
      console.log(`  Loop ${3 + i}: consecutiveNoProgress=${result.metrics.consecutiveNoProgress}, isStagnant=${result.isStagnant}`);
      
      if (i === 3 && result.isStagnant) {
        console.log("  ✅ PASS: Stagnation detected after 3 loops with no progress\n");
        break;
      } else if (i === 4 && !result.isStagnant) {
        console.log("  ❌ FAIL: Stagnation NOT detected after threshold\n");
      }
    }
    
    // Cleanup
    await deleteExecution(execution.id);
    console.log("✓ Cleaned up test execution");
    
  } finally {
    rmSync(testDir, { recursive: true, force: true });
    console.log(`✓ Cleaned up test repo: ${testDir}`);
  }
  
  console.log("\n✅ Test completed!");
}

runTest().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
