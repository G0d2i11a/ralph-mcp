/**
 * Exploration upgrade checklist tool.
 * Generates a checklist of soft AC that need hard evidence before upgrading to delivery mode.
 */

import { z } from "zod";
import {
  findExecutionByBranch,
  listUserStoriesByExecutionId,
  updateExecution,
} from "../store/state.js";
import { getSoftAcList, hasAllHardEvidence } from "../utils/evidence-validation.js";
import { getModeBadge } from "../config/modes.js";

export const upgradeChecklistInputSchema = z.object({
  branch: z.string().describe("Branch name (e.g., ralph/task1-agent)"),
  upgrade: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true and all AC have hard evidence, upgrade mode to delivery"),
});

export type UpgradeChecklistInput = z.infer<typeof upgradeChecklistInputSchema>;

export interface SoftAcItem {
  storyId: string;
  storyTitle: string;
  acKey: string;
  criterion: string;
  status: "untested" | "partial";
  blockedReason?: string;
  nextSteps?: string;
}

export interface UpgradeChecklistResult {
  branch: string;
  currentMode: string;
  currentModeBadge: string;
  canUpgrade: boolean;
  softAcCount: number;
  hardAcCount: number;
  totalAcCount: number;
  softAcItems: SoftAcItem[];
  upgraded: boolean;
  message: string;
}

export async function upgradeChecklist(
  input: UpgradeChecklistInput
): Promise<UpgradeChecklistResult> {
  // Find execution by branch
  const exec = await findExecutionByBranch(input.branch);

  if (!exec) {
    throw new Error(`No execution found for branch: ${input.branch}`);
  }

  const currentMode = exec.mode;
  const currentModeBadge = getModeBadge(currentMode);

  // Get all stories for this execution
  const stories = await listUserStoriesByExecutionId(exec.id);

  // Collect all soft AC across all stories
  const softAcItems: SoftAcItem[] = [];
  let totalAcCount = 0;
  let hardAcCount = 0;

  for (const story of stories) {
    const acEvidence = story.acEvidence || {};
    totalAcCount += story.acceptanceCriteria.length;

    // Get soft AC for this story
    const softAcList = getSoftAcList(acEvidence, story.acceptanceCriteria);

    for (const softAc of softAcList) {
      softAcItems.push({
        storyId: story.storyId,
        storyTitle: story.title,
        acKey: softAc.acKey,
        criterion: softAc.criterion,
        status: softAc.status as "untested" | "partial",
        blockedReason: softAc.blockedReason,
        nextSteps: softAc.nextSteps,
      });
    }

    // Count hard AC (passed with evidence)
    for (const [, evidence] of Object.entries(acEvidence)) {
      const status = evidence.status || (evidence.passes ? "passed" : "failed");
      if (status === "passed") {
        hardAcCount++;
      }
    }
  }

  const softAcCount = softAcItems.length;
  const canUpgrade = softAcCount === 0;

  // Attempt upgrade if requested and possible
  let upgraded = false;
  let message: string;

  if (currentMode !== "exploration") {
    message = `${currentModeBadge} Already in ${currentMode} mode. Upgrade checklist only applies to exploration mode.`;
  } else if (canUpgrade) {
    if (input.upgrade) {
      // Upgrade to delivery mode
      await updateExecution(exec.id, {
        mode: "delivery",
        updatedAt: new Date(),
      });
      upgraded = true;
      message = `[DELIVERY] Successfully upgraded from exploration to delivery mode. All ${hardAcCount} AC have hard evidence.`;
    } else {
      message = `${currentModeBadge} Ready to upgrade! All ${hardAcCount} AC have hard evidence. Set upgrade: true to proceed.`;
    }
  } else {
    message = `${currentModeBadge} Cannot upgrade: ${softAcCount} AC still need hard evidence. See softAcItems for details.`;
  }

  return {
    branch: input.branch,
    currentMode,
    currentModeBadge,
    canUpgrade,
    softAcCount,
    hardAcCount,
    totalAcCount,
    softAcItems,
    upgraded,
    message,
  };
}
