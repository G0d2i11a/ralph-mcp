/**
 * Evidence validation utilities for mode-aware AC requirements.
 */

import { type ExecutionMode, getModeConfig, getModeBadge } from "../config/modes.js";
import { type AcEvidence, type AcStatus } from "../store/state.js";

export interface EvidenceValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  softAcCount: number;
  hardAcCount: number;
  mode: ExecutionMode;
  modeBadge: string;
}

/**
 * Validate AC evidence based on execution mode.
 * - Exploration mode: allows untested/partial AC with blockedReason and nextSteps
 * - Delivery/Hotfix mode: requires hard evidence for all AC
 */
export function validateEvidence(
  acEvidence: Record<string, AcEvidence>,
  acceptanceCriteria: string[],
  mode: ExecutionMode
): EvidenceValidationResult {
  const config = getModeConfig(mode);
  const modeBadge = getModeBadge(mode);
  const errors: string[] = [];
  const warnings: string[] = [];
  let softAcCount = 0;
  let hardAcCount = 0;

  for (let i = 0; i < acceptanceCriteria.length; i++) {
    const acKey = `AC-${i + 1}`;
    const evidence = acEvidence[acKey];

    if (!evidence) {
      if (config.requireHardEvidence) {
        errors.push(`${modeBadge} ${acKey}: Missing evidence (required in ${mode} mode)`);
      } else {
        warnings.push(`${modeBadge} ${acKey}: No evidence provided`);
      }
      continue;
    }

    const status = evidence.status || (evidence.passes ? "passed" : "failed");

    if (status === "untested" || status === "partial") {
      softAcCount++;

      if (!config.allowSoftAC) {
        errors.push(
          `${modeBadge} ${acKey}: Soft AC (${status}) not allowed in ${mode} mode. ` +
          `Provide hard evidence or switch to exploration mode.`
        );
        continue;
      }

      // In exploration mode, soft AC requires blockedReason and nextSteps
      if (!evidence.blockedReason) {
        errors.push(
          `${modeBadge} ${acKey}: Soft AC (${status}) requires blockedReason`
        );
      }
      if (!evidence.nextSteps) {
        errors.push(
          `${modeBadge} ${acKey}: Soft AC (${status}) requires nextSteps`
        );
      }
    } else if (status === "passed") {
      hardAcCount++;

      // Hard evidence should have at least evidence or command+output
      if (!evidence.evidence && !(evidence.command && evidence.output)) {
        warnings.push(
          `${modeBadge} ${acKey}: Passed but missing evidence details (evidence or command+output)`
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    softAcCount,
    hardAcCount,
    mode,
    modeBadge,
  };
}

/**
 * Get evidence requirements section for agent prompt.
 */
export function getEvidenceRequirementsPromptSection(mode: ExecutionMode): string {
  const config = getModeConfig(mode);
  const modeBadge = getModeBadge(mode);

  if (config.allowSoftAC) {
    return `## Evidence Requirements ${modeBadge}

**Exploration Mode** allows soft AC (untested/partial):
- Mark AC as \`"status": "untested"\` or \`"status": "partial"\` if you cannot provide hard evidence yet
- Soft AC MUST include \`blockedReason\` explaining why evidence is not available
- Soft AC MUST include \`nextSteps\` describing what needs to be done to complete it

**Soft AC Example:**
\`\`\`json
{
  "AC-3": {
    "passes": false,
    "status": "untested",
    "blockedReason": "Requires integration test environment not available locally",
    "nextSteps": "Set up test environment and run integration tests"
  }
}
\`\`\`

**Note:** When upgrading to Delivery mode, all soft AC must be resolved with hard evidence.`;
  }

  return `## Evidence Requirements ${modeBadge}

**${mode.charAt(0).toUpperCase() + mode.slice(1)} Mode** requires hard evidence for ALL AC:
- Each AC must have \`passes: true\` with supporting evidence
- Provide \`evidence\` (description) and/or \`command\` + \`output\`
- No untested or partial AC allowed

**Hard Evidence Example:**
\`\`\`json
{
  "AC-1": {
    "passes": true,
    "evidence": "Added migration file db/migrations/001_add_column.sql",
    "command": "pnpm db:migrate",
    "output": "Migration applied successfully"
  }
}
\`\`\``;
}

/**
 * Check if all AC have hard evidence (for upgrade from exploration to delivery).
 */
export function hasAllHardEvidence(acEvidence: Record<string, AcEvidence>): boolean {
  for (const evidence of Object.values(acEvidence)) {
    const status = evidence.status || (evidence.passes ? "passed" : "failed");
    if (status === "untested" || status === "partial") {
      return false;
    }
  }
  return true;
}

/**
 * Get list of soft AC for upgrade checklist.
 */
export function getSoftAcList(
  acEvidence: Record<string, AcEvidence>,
  acceptanceCriteria: string[]
): Array<{
  acKey: string;
  criterion: string;
  status: AcStatus;
  blockedReason?: string;
  nextSteps?: string;
}> {
  const softAc: Array<{
    acKey: string;
    criterion: string;
    status: AcStatus;
    blockedReason?: string;
    nextSteps?: string;
  }> = [];

  for (let i = 0; i < acceptanceCriteria.length; i++) {
    const acKey = `AC-${i + 1}`;
    const evidence = acEvidence[acKey];

    if (!evidence) continue;

    const status = evidence.status || (evidence.passes ? "passed" : "failed");
    if (status === "untested" || status === "partial") {
      softAc.push({
        acKey,
        criterion: acceptanceCriteria[i],
        status,
        blockedReason: evidence.blockedReason,
        nextSteps: evidence.nextSteps,
      });
    }
  }

  return softAc;
}
