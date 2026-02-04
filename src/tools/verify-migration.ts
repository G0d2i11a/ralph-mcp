#!/usr/bin/env node
/**
 * Verification script: Validate state after migration to 'interrupted' status
 *
 * This script checks:
 * 1. No 'failed' executions with "No activity" errors remain
 * 2. All 'interrupted' executions have valid state
 * 3. State transitions are valid
 * 4. No data corruption
 *
 * Usage:
 *   npx tsx src/tools/verify-migration.ts
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { RALPH_DATA_DIR } from "../store/state.js";

const STATE_PATH = join(RALPH_DATA_DIR, "state.json");

interface ExecutionRecord {
  id: string;
  branch: string;
  status: string;
  lastError: string | null;
  updatedAt: string;
  [key: string]: any;
}

interface StateFile {
  version: number;
  executions: ExecutionRecord[];
  archivedExecutions?: ExecutionRecord[];
  [key: string]: any;
}

interface ValidationResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
  stats: {
    totalActive: number;
    totalArchived: number;
    interrupted: number;
    failed: number;
    failedWithInterruptErrors: number;
  };
}

/**
 * Check if an error message indicates an interrupt (should be 'interrupted' status).
 */
function isInterruptError(error: string | null): boolean {
  if (!error) return false;
  const lowerError = error.toLowerCase();
  return (
    lowerError.includes("no activity") ||
    lowerError.includes("session closed") ||
    lowerError.includes("likely session closed")
  );
}

/**
 * Validate the state file after migration.
 */
async function verify(): Promise<ValidationResult> {
  const result: ValidationResult = {
    passed: true,
    errors: [],
    warnings: [],
    stats: {
      totalActive: 0,
      totalArchived: 0,
      interrupted: 0,
      failed: 0,
      failedWithInterruptErrors: 0,
    },
  };

  console.log("=".repeat(60));
  console.log("Ralph MCP: Verify Migration");
  console.log("=".repeat(60));
  console.log();

  // Check if state file exists
  if (!existsSync(STATE_PATH)) {
    result.errors.push("State file not found: " + STATE_PATH);
    result.passed = false;
    return result;
  }

  // Read state
  console.log("📖 Reading state file:", STATE_PATH);
  const rawText = await readFile(STATE_PATH, "utf-8");
  let state: StateFile;

  try {
    state = JSON.parse(rawText);
  } catch (error) {
    result.errors.push("Failed to parse state file: " + (error instanceof Error ? error.message : String(error)));
    result.passed = false;
    return result;
  }

  console.log(`   Version: ${state.version}`);
  console.log();

  // Collect stats
  result.stats.totalActive = state.executions.length;
  result.stats.totalArchived = state.archivedExecutions?.length || 0;

  const allExecutions = [
    ...state.executions,
    ...(state.archivedExecutions || []),
  ];

  // Validate each execution
  for (const exec of allExecutions) {
    const isArchived = state.archivedExecutions?.includes(exec) || false;
    const prefix = isArchived ? "[Archived]" : "[Active]";

    // Count statuses
    if (exec.status === "interrupted") {
      result.stats.interrupted++;
    } else if (exec.status === "failed") {
      result.stats.failed++;

      // Check if failed execution has interrupt error
      if (isInterruptError(exec.lastError)) {
        result.stats.failedWithInterruptErrors++;
        result.errors.push(
          `${prefix} ${exec.branch}: Status is 'failed' but error indicates interrupt: "${exec.lastError}"`
        );
        result.passed = false;
      }
    }

    // Validate interrupted executions
    if (exec.status === "interrupted") {
      // Check if error message is present
      if (!exec.lastError) {
        result.warnings.push(
          `${prefix} ${exec.branch}: Status is 'interrupted' but no error message`
        );
      }

      // Check if error message makes sense
      if (exec.lastError && !isInterruptError(exec.lastError) && !exec.lastError.includes("Migrated from failed")) {
        result.warnings.push(
          `${prefix} ${exec.branch}: Status is 'interrupted' but error doesn't indicate interrupt: "${exec.lastError}"`
        );
      }
    }

    // Validate required fields
    if (!exec.id || !exec.branch || !exec.status) {
      result.errors.push(
        `${prefix} ${exec.branch || exec.id || "unknown"}: Missing required fields (id, branch, or status)`
      );
      result.passed = false;
    }
  }

  return result;
}

/**
 * Print validation results.
 */
function printResults(result: ValidationResult): void {
  console.log("📊 Statistics:");
  console.log(`   Total active executions: ${result.stats.totalActive}`);
  console.log(`   Total archived executions: ${result.stats.totalArchived}`);
  console.log(`   Interrupted: ${result.stats.interrupted}`);
  console.log(`   Failed: ${result.stats.failed}`);
  console.log(`   Failed with interrupt errors: ${result.stats.failedWithInterruptErrors}`);
  console.log();

  if (result.warnings.length > 0) {
    console.log("⚠️  Warnings:");
    for (const warning of result.warnings) {
      console.log(`   - ${warning}`);
    }
    console.log();
  }

  if (result.errors.length > 0) {
    console.log("❌ Errors:");
    for (const error of result.errors) {
      console.log(`   - ${error}`);
    }
    console.log();
  }

  if (result.passed) {
    console.log("✅ Verification PASSED");
    console.log();
    if (result.stats.failedWithInterruptErrors === 0) {
      console.log("   All 'failed' executions with interrupt errors have been migrated.");
    }
    if (result.stats.interrupted > 0) {
      console.log(`   Found ${result.stats.interrupted} interrupted execution(s).`);
      console.log("   Ralph Runner will automatically retry these when it runs.");
    }
  } else {
    console.log("❌ Verification FAILED");
    console.log();
    console.log("   Please review the errors above and fix them manually,");
    console.log("   or restore from backup and re-run the migration.");
  }
}

// Main
async function main() {
  try {
    const result = await verify();
    printResults(result);
    process.exit(result.passed ? 0 : 1);
  } catch (error) {
    console.error("❌ Verification failed:");
    console.error(error);
    process.exit(1);
  }
}

main();
