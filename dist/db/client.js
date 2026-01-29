import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import * as schema from "./schema.js";
const RALPH_DATA_DIR = process.env.RALPH_DATA_DIR?.replace("~", homedir()) ||
    join(homedir(), ".ralph");
// Ensure data directory exists
if (!existsSync(RALPH_DATA_DIR)) {
    mkdirSync(RALPH_DATA_DIR, { recursive: true });
}
const DB_PATH = join(RALPH_DATA_DIR, "state.db");
const sqlite = new Database(DB_PATH);
// Enable WAL mode for better concurrency
sqlite.pragma("journal_mode = WAL");
export const db = drizzle(sqlite, { schema });
// Initialize tables
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS executions (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    branch TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    prd_path TEXT NOT NULL,
    project_root TEXT NOT NULL,
    worktree_path TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    agent_task_id TEXT,
    on_conflict TEXT DEFAULT 'agent',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_stories (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    story_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    acceptance_criteria TEXT NOT NULL,
    priority INTEGER NOT NULL,
    passes INTEGER NOT NULL DEFAULT 0,
    notes TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS merge_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL
  );
`);
export { RALPH_DATA_DIR };
