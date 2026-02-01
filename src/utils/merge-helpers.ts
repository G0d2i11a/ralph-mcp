import { execSync, exec } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { RalphConfig, Gate, DEFAULT_CONFIG } from "../config/schema.js";

const execAsync = promisify(exec);

export interface GateResult {
  id: string;
  name: string;
  success: boolean;
  output: string;
  durationMs: number;
}

export interface QualityCheckResult {
  success: boolean;
  gates: GateResult[];
  // Legacy fields for backward compatibility
  typeCheck: { success: boolean; output: string };
  build: { success: boolean; output: string };
}

export interface SyncResult {
  success: boolean;
  hasConflicts: boolean;
  conflictFiles?: string[];
  message: string;
}

/**
 * Sync main branch to feature branch before merge
 */
export async function syncMainToBranch(
  worktreePath: string,
  branch: string,
  config?: RalphConfig
): Promise<SyncResult> {
  const mainBranch = config?.merge?.mainBranch || DEFAULT_CONFIG.merge.mainBranch;
  const remote = config?.merge?.remote ?? DEFAULT_CONFIG.merge.remote;

  try {
    // Check if remote exists (skip if remote is null)
    let hasRemote = false;
    if (remote) {
      try {
        const { stdout } = await execAsync("git remote", { cwd: worktreePath });
        hasRemote = stdout.includes(remote);
      } catch {
        hasRemote = false;
      }
    }

    // Fetch latest main only if remote exists
    if (hasRemote && remote) {
      await execAsync(`git fetch ${remote} ${mainBranch}`, { cwd: worktreePath });
    }

    // Try to merge main into feature branch
    const mergeTarget = hasRemote && remote ? `${remote}/${mainBranch}` : mainBranch;
    try {
      await execAsync(`git merge ${mergeTarget} --no-edit`, { cwd: worktreePath });
      return {
        success: true,
        hasConflicts: false,
        message: "Successfully synced main to feature branch",
      };
    } catch (mergeError) {
      // Check for conflicts
      const { stdout: status } = await execAsync("git status --porcelain", {
        cwd: worktreePath,
      });

      const conflictFiles = status
        .split("\n")
        .filter((line) => line.startsWith("UU ") || line.startsWith("AA "))
        .map((line) => line.slice(3));

      if (conflictFiles.length > 0) {
        return {
          success: false,
          hasConflicts: true,
          conflictFiles,
          message: `Conflicts when syncing main: ${conflictFiles.join(", ")}`,
        };
      }

      throw mergeError;
    }
  } catch (error) {
    return {
      success: false,
      hasConflicts: false,
      message: `Failed to sync main: ${error}`,
    };
  }
}

/**
 * Run a single quality gate
 */
async function runGate(
  worktreePath: string,
  gate: Gate
): Promise<GateResult> {
  const startTime = Date.now();
  const cwd = gate.cwd ? join(worktreePath, gate.cwd) : worktreePath;

  try {
    const { stdout, stderr } = await execAsync(gate.command, {
      cwd,
      timeout: gate.timeoutMs || 120000,
    });
    return {
      id: gate.id,
      name: gate.name,
      success: true,
      output: stdout || stderr,
      durationMs: Date.now() - startTime,
    };
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string };
    return {
      id: gate.id,
      name: gate.name,
      success: false,
      output: execError.stdout || execError.stderr || String(error),
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Run quality checks (configurable gates or legacy type check and build)
 */
export async function runQualityChecks(
  worktreePath: string,
  config?: RalphConfig
): Promise<QualityCheckResult> {
  const gates = config?.gates || DEFAULT_CONFIG.gates;

  // If no gates configured, use legacy hardcoded checks
  if (gates.length === 0) {
    return runLegacyQualityChecks(worktreePath);
  }

  // Filter gates that should run pre-merge
  const preMergeGates = gates.filter((g) => g.when === "pre-merge" || g.when === "always");

  const gateResults: GateResult[] = [];
  let allSuccess = true;

  for (const gate of preMergeGates) {
    const result = await runGate(worktreePath, gate);
    gateResults.push(result);

    if (!result.success && gate.required) {
      allSuccess = false;
      break; // Stop on first required gate failure
    }
  }

  // Build legacy-compatible result
  const typeCheckGate = gateResults.find((g) => g.id === "type-check" || g.id === "typecheck");
  const buildGate = gateResults.find((g) => g.id === "build");

  return {
    success: allSuccess,
    gates: gateResults,
    typeCheck: typeCheckGate
      ? { success: typeCheckGate.success, output: typeCheckGate.output }
      : { success: true, output: "" },
    build: buildGate
      ? { success: buildGate.success, output: buildGate.output }
      : { success: true, output: "" },
  };
}

/**
 * Legacy quality checks (hardcoded pnpm commands)
 */
async function runLegacyQualityChecks(
  worktreePath: string
): Promise<QualityCheckResult> {
  const result: QualityCheckResult = {
    success: false,
    gates: [],
    typeCheck: { success: false, output: "" },
    build: { success: false, output: "" },
  };

  // Run type check
  try {
    const { stdout, stderr } = await execAsync("pnpm check-types", {
      cwd: worktreePath,
      timeout: 120000, // 2 minutes
    });
    result.typeCheck = { success: true, output: stdout || stderr };
    result.gates.push({
      id: "type-check",
      name: "Type Check",
      success: true,
      output: stdout || stderr,
      durationMs: 0,
    });
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string };
    result.typeCheck = {
      success: false,
      output: execError.stdout || execError.stderr || String(error),
    };
    result.gates.push({
      id: "type-check",
      name: "Type Check",
      success: false,
      output: execError.stdout || execError.stderr || String(error),
      durationMs: 0,
    });
    return result;
  }

  // Run build (only API for now, as it's the critical one)
  try {
    const { stdout, stderr } = await execAsync("pnpm --filter api build", {
      cwd: worktreePath,
      timeout: 180000, // 3 minutes
    });
    result.build = { success: true, output: stdout || stderr };
    result.gates.push({
      id: "build",
      name: "Build",
      success: true,
      output: stdout || stderr,
      durationMs: 0,
    });
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string };
    result.build = {
      success: false,
      output: execError.stdout || execError.stderr || String(error),
    };
    result.gates.push({
      id: "build",
      name: "Build",
      success: false,
      output: execError.stdout || execError.stderr || String(error),
      durationMs: 0,
    });
    return result;
  }

  result.success = true;
  return result;
}

/**
 * Generate commit message with US list
 */
export function generateCommitMessage(
  branch: string,
  description: string,
  completedStories: { id: string; title: string }[],
  config?: RalphConfig
): string {
  const coAuthor = config?.agent?.coAuthor || DEFAULT_CONFIG.agent.coAuthor;

  const storyList = completedStories
    .map((s) => `- ${s.id}: ${s.title}`)
    .join("\n");

  return `merge: ${branch} - ${description}

Completed User Stories:
${storyList || "- No stories tracked"}

Co-Authored-By: ${coAuthor}`;
}

/**
 * Get list of commits on branch since diverging from main
 */
export async function getBranchCommits(
  projectRoot: string,
  branch: string
): Promise<string[]> {
  try {
    const { stdout } = await execAsync(
      `git log main..${branch} --oneline --no-merges`,
      { cwd: projectRoot }
    );
    return stdout.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Update TODO.md to mark PRD-related items as completed
 * Uses fuzzy matching based on keywords from the PRD description
 */
export function updateTodoDoc(
  projectRoot: string,
  branch: string,
  description: string
): boolean {
  const todoPath = join(projectRoot, "docs", "TODO.md");
  if (!existsSync(todoPath)) {
    return false;
  }

  try {
    let content = readFileSync(todoPath, "utf-8");
    let updated = false;

    // Extract keywords from description and branch for matching
    const keywords = extractKeywords(description, branch);

    // Find unchecked items that match keywords
    const lines = content.split("\n");
    const updatedLines = lines.map((line) => {
      // Only process unchecked items
      if (!line.match(/^(\s*)- \[ \]/)) {
        return line;
      }

      // Check if line matches any keywords
      const lineLower = line.toLowerCase();
      const matchCount = keywords.filter((kw) => lineLower.includes(kw)).length;

      // Require at least 2 keyword matches for confidence
      if (matchCount >= 2) {
        updated = true;
        return line.replace("- [ ]", "- [x]");
      }

      return line;
    });

    if (updated) {
      writeFileSync(todoPath, updatedLines.join("\n"), "utf-8");
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Extract keywords from PRD description and branch name
 */
function extractKeywords(description: string, branch: string): string[] {
  const keywords: string[] = [];

  // Common words to ignore
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "as", "is", "was", "are", "were", "been",
    "be", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "must", "shall", "can", "need",
    "prd", "ralph", "user", "want", "that", "this", "which", "who",
  ]);

  // Extract from description
  const descWords = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  keywords.push(...descWords);

  // Extract from branch name (e.g., ralph/prd-speaking-dialogue-coach)
  const branchWords = branch
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  keywords.push(...branchWords);

  // Dedupe and return
  return [...new Set(keywords)];
}

/**
 * Update PROJECT-STATUS.md with merge info
 */
export function updateProjectStatus(
  projectRoot: string,
  branch: string,
  description: string,
  commitHash: string
): boolean {
  const statusPath = join(projectRoot, "docs", "PROJECT-STATUS.md");
  if (!existsSync(statusPath)) {
    return false;
  }

  try {
    let content = readFileSync(statusPath, "utf-8");

    // Add to recent merges section or create one
    const date = new Date().toISOString().split("T")[0];
    const mergeEntry = `- ${date}: ${branch} - ${description} (${commitHash.slice(0, 7)})`;

    const recentMergesPattern = /## Recent Merges\n/;
    if (recentMergesPattern.test(content)) {
      content = content.replace(
        recentMergesPattern,
        `## Recent Merges\n${mergeEntry}\n`
      );
    } else {
      // Add section at the end
      content += `\n## Recent Merges\n${mergeEntry}\n`;
    }

    writeFileSync(statusPath, content, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Handle schema.prisma conflicts specially
 */
export async function handleSchemaConflict(
  projectRoot: string
): Promise<boolean> {
  const schemaPath = join(projectRoot, "apps", "api", "src", "infra", "prisma", "schema.prisma");

  if (!existsSync(schemaPath)) {
    return false;
  }

  try {
    // Read the conflicted file
    let content = readFileSync(schemaPath, "utf-8");

    // Check if there are conflict markers
    if (!content.includes("<<<<<<<") && !content.includes(">>>>>>>")) {
      return true; // No conflicts
    }

    // For schema.prisma, we typically want to keep both changes
    // Remove conflict markers and keep all content
    content = content
      .replace(/<<<<<<< HEAD\n/g, "")
      .replace(/=======\n/g, "")
      .replace(/>>>>>>> .+\n/g, "");

    // Remove duplicate model definitions (keep first occurrence)
    const modelPattern = /model (\w+) \{[\s\S]*?\n\}/g;
    const seenModels = new Set<string>();
    content = content.replace(modelPattern, (match, modelName) => {
      if (seenModels.has(modelName)) {
        return ""; // Remove duplicate
      }
      seenModels.add(modelName);
      return match;
    });

    // Clean up extra blank lines
    content = content.replace(/\n{3,}/g, "\n\n");

    writeFileSync(schemaPath, content, "utf-8");

    // Stage the resolved file
    await execAsync(`git add "${schemaPath}"`, { cwd: projectRoot });

    return true;
  } catch {
    return false;
  }
}

/**
 * Update PRD file with completion metadata
 */
export function updatePrdMetadata(
  prdPath: string,
  branch: string,
  commitHash: string
): boolean {
  if (!existsSync(prdPath)) {
    return false;
  }

  try {
    let content = readFileSync(prdPath, "utf-8");
    const executedAt = new Date().toISOString().split("T")[0];

    // Check if file already has frontmatter
    const hasFrontmatter = content.startsWith("---\n");

    const metadata = `---
status: completed
executedAt: ${executedAt}
branch: ${branch}
mergeSha: ${commitHash}
---

`;

    if (hasFrontmatter) {
      // Replace existing frontmatter
      content = content.replace(/^---\n[\s\S]*?\n---\n\n?/, metadata);
    } else {
      // Add frontmatter at the beginning
      content = metadata + content;
    }

    writeFileSync(prdPath, content, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Update tasks/INDEX.md with completed PRD
 */
export function updatePrdIndex(
  projectRoot: string,
  prdPath: string,
  branch: string,
  commitHash: string
): boolean {
  const indexPath = join(projectRoot, "tasks", "INDEX.md");

  if (!existsSync(indexPath)) {
    return false;
  }

  try {
    let content = readFileSync(indexPath, "utf-8");
    const executedAt = new Date().toISOString().split("T")[0];
    const prdFileName = prdPath.split(/[/\\]/).pop() || "";
    const shortHash = commitHash.slice(0, 7);

    // Create entry for completed PRD
    const entry = `| [${prdFileName}](./${prdFileName}) | ${executedAt} | ${branch} | ${shortHash} |`;

    // Find the "已完成" section and add entry
    const completedPattern = /## 已完成\n\n\| PRD \| 完成时间 \| 分支 \| Merge SHA \|\n\|-----|----------|------|-----------|/;

    if (completedPattern.test(content)) {
      content = content.replace(
        completedPattern,
        `## 已完成\n\n| PRD | 完成时间 | 分支 | Merge SHA |\n|-----|----------|------|-----------|
${entry}`
      );
    }

    writeFileSync(indexPath, content, "utf-8");
    return true;
  } catch {
    return false;
  }
}
