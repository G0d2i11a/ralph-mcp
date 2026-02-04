/**
 * Scope guardrails for preventing large changes.
 * Uses mode-specific thresholds to warn or reject changes.
 */

import { type ExecutionMode, type ModeConfig, getModeConfig, getModeBadge } from "../config/modes.js";

export interface ScopeCheckInput {
  diffLines: number;
  filesChanged: number;
  mode: ExecutionMode;
}

export type ScopeCheckSeverity = "ok" | "warn" | "reject";

export interface ScopeCheckResult {
  severity: ScopeCheckSeverity;
  diffCheck: {
    severity: ScopeCheckSeverity;
    actual: number;
    warnThreshold: number;
    hardThreshold: number;
    message: string;
  };
  filesCheck: {
    severity: ScopeCheckSeverity;
    actual: number;
    warnThreshold: number;
    hardThreshold: number;
    message: string;
  };
  mode: ExecutionMode;
  modeBadge: string;
  overallMessage: string;
}

/**
 * Check if the scope of changes is within acceptable limits for the given mode.
 */
export function checkScope(input: ScopeCheckInput): ScopeCheckResult {
  const config = getModeConfig(input.mode);
  const modeBadge = getModeBadge(input.mode);

  // Check diff lines
  const diffCheck = checkThreshold(
    input.diffLines,
    config.diffWarn,
    config.diffHard,
    "lines",
    modeBadge
  );

  // Check files changed
  const filesCheck = checkThreshold(
    input.filesChanged,
    config.filesWarn,
    config.filesHard,
    "files",
    modeBadge
  );

  // Overall severity is the worst of the two
  const severity = getWorstSeverity(diffCheck.severity, filesCheck.severity);

  // Build overall message
  let overallMessage: string;
  if (severity === "ok") {
    overallMessage = `${modeBadge} Scope check passed (${input.diffLines} lines, ${input.filesChanged} files)`;
  } else if (severity === "warn") {
    const warnings: string[] = [];
    if (diffCheck.severity === "warn") warnings.push(diffCheck.message);
    if (filesCheck.severity === "warn") warnings.push(filesCheck.message);
    overallMessage = warnings.join("; ");
  } else {
    const rejections: string[] = [];
    if (diffCheck.severity === "reject") rejections.push(diffCheck.message);
    if (filesCheck.severity === "reject") rejections.push(filesCheck.message);
    overallMessage = rejections.join("; ");
  }

  return {
    severity,
    diffCheck,
    filesCheck,
    mode: input.mode,
    modeBadge,
    overallMessage,
  };
}

function checkThreshold(
  actual: number,
  warnThreshold: number,
  hardThreshold: number,
  unit: string,
  modeBadge: string
): {
  severity: ScopeCheckSeverity;
  actual: number;
  warnThreshold: number;
  hardThreshold: number;
  message: string;
} {
  if (actual > hardThreshold) {
    return {
      severity: "reject",
      actual,
      warnThreshold,
      hardThreshold,
      message: `${modeBadge} REJECTED: ${actual} ${unit} exceeds hard limit (${hardThreshold} ${unit}). Story must be split.`,
    };
  }

  if (actual > warnThreshold) {
    return {
      severity: "warn",
      actual,
      warnThreshold,
      hardThreshold,
      message: `${modeBadge} WARNING: ${actual} ${unit} exceeds warn threshold (${warnThreshold} ${unit}). Provide scopeExplanation.`,
    };
  }

  return {
    severity: "ok",
    actual,
    warnThreshold,
    hardThreshold,
    message: `${modeBadge} OK: ${actual} ${unit} within limits (warn: ${warnThreshold}, hard: ${hardThreshold})`,
  };
}

function getWorstSeverity(a: ScopeCheckSeverity, b: ScopeCheckSeverity): ScopeCheckSeverity {
  if (a === "reject" || b === "reject") return "reject";
  if (a === "warn" || b === "warn") return "warn";
  return "ok";
}

/**
 * Format scope thresholds for display in agent prompt.
 */
export function formatScopeThresholds(mode: ExecutionMode): string {
  const config = getModeConfig(mode);
  const modeBadge = getModeBadge(mode);
  return `${modeBadge} Scope limits: warn at ${config.diffWarn} lines/${config.filesWarn} files, reject at ${config.diffHard} lines/${config.filesHard} files`;
}

/**
 * Get scope guardrails section for agent prompt.
 */
export function getScopeGuardrailsPromptSection(mode: ExecutionMode): string {
  const config = getModeConfig(mode);
  const modeBadge = getModeBadge(mode);

  return `- **SCOPE GUARDRAILS ${modeBadge}:**
  - Warn threshold: >${config.diffWarn} lines or >${config.filesWarn} files → must provide scopeExplanation
  - Hard threshold: >${config.diffHard} lines or >${config.filesHard} files → story rejected, must split
  - scopeExplanation format: \`[{ file: "path/to/file.ts", reason: "why in scope", lines: 123 }]\`
  - Excluded from count: lock files, snapshots, dist/, build/, .next/`;
}
