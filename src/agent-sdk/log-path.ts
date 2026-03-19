import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { RALPH_DATA_DIR } from "../store/state.js";

export function resolveAgentLogPath(
  taskId: string,
  metadata?: Record<string, unknown>
): string {
  const executionId =
    typeof metadata?.executionId === "string" && metadata.executionId.trim().length > 0
      ? metadata.executionId
      : taskId;

  const logsDir = join(RALPH_DATA_DIR, "logs");
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }

  return join(logsDir, `${executionId}.jsonl`);
}
