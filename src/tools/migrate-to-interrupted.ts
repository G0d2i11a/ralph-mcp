#!/usr/bin/env node
/**
 * Migration script: Add 'interrupted' status and migrate existing 'failed' executions
 *
 * This script:
 * 1. Backs up the current state.json
 * 2. Migrates 'failed' executions with "No activity" errors to 'interrupted'
 * 3. Validates the migration
 *
 * Usage:
 *   npx tsx src/tools/migrate-to-interrupted.ts [--dry-run] [--backup-path <path>]
 */

import { existsSync, copyFileSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { RALPH_DATA_DIR } from "../store/state.js";

const STATE_PATH = join(RALPH_DATA_DIR, "state.json");
const DEFAULT_BACKUP_PATH = join(RALPH_DATA_DIR, `state.backup.${Date.now()}.json`);

interface MigrationOptions {
  dryRun: boolean;
  backupPath: string;
}

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

/**
 * Check if a failed execution should be migrated to interrupted.
 * Criteria: status is 'failed' AND lastError contains "No activity" or "session closed"
 */
function shouldMigrateToInterrupted(exec: ExecutionRecord): boolean {
  if (exec.status !== "failed") {
    return false;
  }

  const error = exec.lastError?.toLowerCase() || "";
  return (
    error.includes("no activity") ||
    error.includes("session closed") ||
    error.includes("likely session closed")
  );
}

/**
 * Migrate an execution from 'failed' to 'interrupted'.
 */
function migrateExecution(exec: ExecutionRecord): ExecutionRecord {
  return {
    ...exec,
    status: "interrupted",
    lastError: exec.lastError
      ? `[Migrated from failed] ${exec.lastError}`
      : "[Migrated from failed] Session interrupted",
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Perform the migration.
 */
async function migrate(options: MigrationOptions): Promise<void> {
  console.log("=".repeat(60));
  console.log("Ralph MCP: Migrate to 'interrupted' status");
  console.log("=".repeat(60));
  console.log();

  // Check if state file exists
  if (!existsSync(STATE_PATH)) {
    console.log("❌ State file not found:", STATE_PATH);
    console.log("   Nothing to migrate.");
    process.exit(0);
  }

  // Read current state
  console.log("📖 Reading state file:", STATE_PATH);
  const rawText = await readFile(STATE_PATH, "utf-8");
  const state: StateFile = JSON.parse(rawText);

  console.log(`   Version: ${state.version}`);
  console.log(`   Active executions: ${state.executions.length}`);
  console.log(`   Archived executions: ${state.archivedExecutions?.length || 0}`);
  console.log();

  // Find executions to migrate
  const toMigrate = state.executions.filter(shouldMigrateToInterrupted);
  const archivedToMigrate = (state.archivedExecutions || []).filter(shouldMigrateToInterrupted);

  console.log("🔍 Migration candidates:");
  console.log(`   Active: ${toMigrate.length}`);
  console.log(`   Archived: ${archivedToMigrate.length}`);
  console.log();

  if (toMigrate.length === 0 && archivedToMigrate.length === 0) {
    console.log("✅ No executions need migration.");
    console.log("   All 'failed' executions have non-interrupt errors.");
    process.exit(0);
  }

  // Show details
  if (toMigrate.length > 0) {
    console.log("📋 Active executions to migrate:");
    for (const exec of toMigrate) {
      console.log(`   - ${exec.branch}`);
      console.log(`     Status: ${exec.status} → interrupted`);
      console.log(`     Error: ${exec.lastError}`);
    }
    console.log();
  }

  if (archivedToMigrate.length > 0) {
    console.log("📋 Archived executions to migrate:");
    for (const exec of archivedToMigrate) {
      console.log(`   - ${exec.branch}`);
      console.log(`     Status: ${exec.status} → interrupted`);
    }
    console.log();
  }

  if (options.dryRun) {
    console.log("🔍 DRY RUN MODE - No changes will be made");
    console.log();
    console.log("Summary:");
    console.log(`   Would migrate ${toMigrate.length} active executions`);
    console.log(`   Would migrate ${archivedToMigrate.length} archived executions`);
    process.exit(0);
  }

  // Backup
  console.log("💾 Creating backup:", options.backupPath);
  copyFileSync(STATE_PATH, options.backupPath);
  console.log("   ✅ Backup created");
  console.log();

  // Perform migration
  console.log("🔄 Migrating executions...");
  const migratedState: StateFile = {
    ...state,
    executions: state.executions.map((exec) =>
      shouldMigrateToInterrupted(exec) ? migrateExecution(exec) : exec
    ),
    archivedExecutions: (state.archivedExecutions || []).map((exec) =>
      shouldMigrateToInterrupted(exec) ? migrateExecution(exec) : exec
    ),
  };

  // Write migrated state
  await writeFile(STATE_PATH, JSON.stringify(migratedState, null, 2), "utf-8");
  console.log("   ✅ State file updated");
  console.log();

  // Validation
  console.log("✅ Migration complete!");
  console.log();
  console.log("Summary:");
  console.log(`   Migrated ${toMigrate.length} active executions`);
  console.log(`   Migrated ${archivedToMigrate.length} archived executions`);
  console.log(`   Backup saved to: ${options.backupPath}`);
  console.log();
  console.log("Next steps:");
  console.log("   1. Run 'ralph_status' to verify the migration");
  console.log("   2. Ensure Ralph Runner is running to auto-retry interrupted executions");
  console.log("   3. If issues occur, restore from backup:");
  console.log(`      cp ${options.backupPath} ${STATE_PATH}`);
}

/**
 * Parse command-line arguments.
 */
function parseArgs(): MigrationOptions {
  const args = process.argv.slice(2);
  const options: MigrationOptions = {
    dryRun: false,
    backupPath: DEFAULT_BACKUP_PATH,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--backup-path":
        if (args[i + 1]) {
          options.backupPath = args[i + 1];
          i++;
        }
        break;
      case "--help":
      case "-h":
        console.log(`
Usage: npx tsx src/tools/migrate-to-interrupted.ts [options]

Options:
  --dry-run           Show what would be migrated without making changes
  --backup-path PATH  Custom backup file path (default: ~/.ralph/state.backup.<timestamp>.json)
  -h, --help          Show this help message

Description:
  Migrates 'failed' executions with "No activity" or "session closed" errors
  to the new 'interrupted' status. This allows Ralph Runner to automatically
  retry these executions.

Examples:
  npx tsx src/tools/migrate-to-interrupted.ts --dry-run
  npx tsx src/tools/migrate-to-interrupted.ts
  npx tsx src/tools/migrate-to-interrupted.ts --backup-path /tmp/backup.json
`);
        process.exit(0);
      default:
        console.error(`Unknown option: ${arg}`);
        console.error('Run with --help for usage information');
        process.exit(1);
    }
  }

  return options;
}

// Main
async function main() {
  try {
    const options = parseArgs();
    await migrate(options);
  } catch (error) {
    console.error("❌ Migration failed:");
    console.error(error);
    process.exit(1);
  }
}

main();
