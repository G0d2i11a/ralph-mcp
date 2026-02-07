/**
 * Execution mode configurations for Ralph MCP.
 *
 * Three modes are supported:
 * - exploration: For PoC and exploration work, with relaxed constraints
 * - delivery: Default mode for production-ready code, with strict constraints
 * - hotfix: For emergency fixes, with minimal scope constraints
 */

export type ExecutionMode = "exploration" | "delivery" | "hotfix";

export interface ModeConfig {
  /** Diff line count warning threshold */
  diffWarn: number;
  /** Diff line count hard limit (reject if exceeded) */
  diffHard: number;
  /** File count warning threshold */
  filesWarn: number;
  /** File count hard limit (reject if exceeded) */
  filesHard: number;
  /** Maximum retry attempts */
  maxRetries: number;
  /** Whether hard evidence is required for all AC */
  requireHardEvidence: boolean;
  /** Whether soft AC (untested/partial) is allowed */
  allowSoftAC: boolean;
}

/**
 * Mode configurations with their respective thresholds.
 */
export const MODE_CONFIGS: Record<ExecutionMode, ModeConfig> = {
  delivery: {
    diffWarn: 1500,
    diffHard: 3000,
    filesWarn: 15,
    filesHard: 25,
    maxRetries: 3,
    requireHardEvidence: true,
    allowSoftAC: false,
  },
  exploration: {
    diffWarn: 3000,
    diffHard: 8000,
    filesWarn: 25,
    filesHard: 60,
    maxRetries: 7,
    requireHardEvidence: false,
    allowSoftAC: true,
  },
  hotfix: {
    diffWarn: 300,
    diffHard: 800,
    filesWarn: 8,
    filesHard: 15,
    maxRetries: 2,
    requireHardEvidence: true,
    allowSoftAC: false,
  },
};

/**
 * Default execution mode.
 */
export const DEFAULT_MODE: ExecutionMode = "delivery";

/**
 * Valid execution modes.
 */
export const VALID_MODES: ExecutionMode[] = ["exploration", "delivery", "hotfix"];

/**
 * Check if a string is a valid execution mode.
 */
export function isValidMode(mode: string): mode is ExecutionMode {
  return VALID_MODES.includes(mode as ExecutionMode);
}

/**
 * Get mode configuration, with fallback to delivery mode.
 */
export function getModeConfig(mode: ExecutionMode | string | undefined): ModeConfig {
  if (mode && isValidMode(mode)) {
    return MODE_CONFIGS[mode];
  }
  return MODE_CONFIGS[DEFAULT_MODE];
}

/**
 * Get human-readable mode description for display.
 */
export function getModeDescription(mode: ExecutionMode): string {
  const config = MODE_CONFIGS[mode];
  switch (mode) {
    case "exploration":
      return `Exploration Mode (allows soft AC, thresholds: ${config.diffWarn}/${config.diffHard} lines, ${config.filesWarn}/${config.filesHard} files)`;
    case "delivery":
      return `Delivery Mode (requires hard evidence, thresholds: ${config.diffWarn}/${config.diffHard} lines, ${config.filesWarn}/${config.filesHard} files)`;
    case "hotfix":
      return `Hotfix Mode (minimal scope, thresholds: ${config.diffWarn}/${config.diffHard} lines, ${config.filesWarn}/${config.filesHard} files)`;
  }
}

/**
 * Get mode badge for status display.
 */
export function getModeBadge(mode: ExecutionMode): string {
  switch (mode) {
    case "exploration":
      return "[EXPLORATION]";
    case "delivery":
      return "[DELIVERY]";
    case "hotfix":
      return "[HOTFIX]";
  }
}
