import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { RALPH_DATA_DIR } from "../store/state.js";

const CONCURRENCY_CONFIG_FILE = join(RALPH_DATA_DIR, "concurrency.json");

export interface ConcurrencyConfig {
  maxConcurrent: number;
  updatedAt: string;
  reason?: string;
}

/**
 * Read current concurrency configuration.
 */
export function readConcurrencyConfig(): ConcurrencyConfig | null {
  if (!existsSync(CONCURRENCY_CONFIG_FILE)) {
    return null;
  }

  try {
    const content = readFileSync(CONCURRENCY_CONFIG_FILE, "utf-8");
    return JSON.parse(content) as ConcurrencyConfig;
  } catch {
    return null;
  }
}

/**
 * Write concurrency configuration.
 */
export function writeConcurrencyConfig(config: ConcurrencyConfig): void {
  writeFileSync(CONCURRENCY_CONFIG_FILE, JSON.stringify(config, null, 2));
}
