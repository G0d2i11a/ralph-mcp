import Database from "better-sqlite3";
import * as schema from "./schema.js";
declare const RALPH_DATA_DIR: string;
export declare const db: import("drizzle-orm/better-sqlite3").BetterSQLite3Database<typeof schema> & {
    $client: Database.Database;
};
export { RALPH_DATA_DIR };
