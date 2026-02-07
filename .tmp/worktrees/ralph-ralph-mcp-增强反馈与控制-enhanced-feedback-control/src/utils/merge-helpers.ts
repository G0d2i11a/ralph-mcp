import { execSync, exec } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const execAsync = promisify(exec);

export interface QualityCheckResult {
  success: boolean;
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
  branch: string
): Promise<SyncResult> {
  try {
    // Check if origin remote exists
    let hasOrigin = false;
    try {
      const { stdout } = await execAsync("git remote", { cwd: worktreePath });
      hasOrigin = stdout.includes("origin");
    } catch {
      hasOrigin = false;
    }

    // Fetch latest main only if origin exists
    if (hasOrigin) {
      await execAsync("git fetch origin main", { cwd: worktreePath });
    }

    // Try to merge main into feature branch
    const mergeTarget = hasOrigin ? "origin/main" : "main";
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
 * Run quality checks (type check and build)
 */
export async function runQualityChecks(
  worktreePath: string
): Promise<QualityCheckResult> {
  const result: QualityCheckResult = {
    success: false,
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
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string };
    result.typeCheck = {
      success: false,
      output: execError.stdout || execError.stderr || String(error),
    };
    return result;
  }

  // Run build (only API for now, as it's the critical one)
  try {
    const { stdout, stderr } = await execAsync("pnpm --filter api build", {
      cwd: worktreePath,
      timeout: 180000, // 3 minutes
    });
    result.build = { success: true, output: stdout || stderr };
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string };
    result.build = {
      success: false,
      output: execError.stdout || execError.stderr || String(error),
    };
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
  completedStories: { id: string; title: string }[]
): string {
  const storyList = completedStories
    .map((s) => `- ${s.id}: ${s.title}`)
    .join("\n");

  return `merge: ${branch} - ${description}

Completed User Stories:
${storyList || "- No stories tracked"}

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>`;
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

/**
 * Diff statistics grouped by directory
 */
export interface DiffStats {
  totalLines: number;
  totalFiles: number;
  byDirectory: Record<string, { files: number; lines: number }>;
}

/**
 * Risk level based on diff size
 */
export type RiskLevel = "low" | "medium" | "high";

/**
 * Merge report data structure
 */
export interface MergeReportData {
  branch: string;
  description: string;
  completedStories: Array<{
    id: string;
    title: string;
    acCount: number;
    acCompleted: number;
    evidence: string;
  }>;
  diffStats: DiffStats;
  qualityChecks: {
    typeCheck: boolean;
    build: boolean;
    tests?: boolean;
  };
  riskAssessment: {
    level: RiskLevel;
    warnings: string[];
  };
  generatedAt: string;
}

/**
 * Get diff statistics for a branch
 */
export async function getDiffStats(
  projectRoot: string,
  branch: string
): Promise<DiffStats> {
  try {
    const { stdout } = await execAsync(
      `git diff --numstat main...${branch}`,
      { cwd: projectRoot }
    );

    const stats: DiffStats = {
      totalLines: 0,
      totalFiles: 0,
      byDirectory: {},
    };

    const lines = stdout.split("\n").filter(Boolean);
    for (const line of lines) {
      const [added, deleted, file] = line.split("\t");
      if (!file) continue;

      const addedNum = parseInt(added, 10) || 0;
      const deletedNum = parseInt(deleted, 10) || 0;
      const totalLines = addedNum + deletedNum;

      stats.totalLines += totalLines;
      stats.totalFiles++;

      // Group by directory
      const dir = file.includes("/") ? file.split("/")[0] : ".";
      if (!stats.byDirectory[dir]) {
        stats.byDirectory[dir] = { files: 0, lines: 0 };
      }
      stats.byDirectory[dir].files++;
      stats.byDirectory[dir].lines += totalLines;
    }

    return stats;
  } catch {
    return {
      totalLines: 0,
      totalFiles: 0,
      byDirectory: {},
    };
  }
}

/**
 * Assess risk level based on diff stats
 */
export function assessRisk(diffStats: DiffStats): {
  level: RiskLevel;
  warnings: string[];
} {
  const warnings: string[] = [];
  let level: RiskLevel = "low";

  // Check total lines changed
  if (diffStats.totalLines > 5000) {
    level = "high";
    warnings.push(
      `⚠️ Large diff: ${diffStats.totalLines} lines changed (threshold: 5000)`
    );
  } else if (diffStats.totalLines > 1500) {
    level = "medium";
    warnings.push(
      `⚠️ Moderate diff: ${diffStats.totalLines} lines changed (threshold: 1500)`
    );
  }

  // Check total files changed
  if (diffStats.totalFiles > 50) {
    level = "high";
    warnings.push(
      `⚠️ Many files changed: ${diffStats.totalFiles} files (threshold: 50)`
    );
  } else if (diffStats.totalFiles > 15) {
    if (level === "low") level = "medium";
    warnings.push(
      `⚠️ Multiple files changed: ${diffStats.totalFiles} files (threshold: 15)`
    );
  }

  // Check for critical directories
  const criticalDirs = ["src/infra", "apps/api/src/infra", "prisma", "schema"];
  for (const dir of criticalDirs) {
    if (diffStats.byDirectory[dir]) {
      if (level === "low") level = "medium";
      warnings.push(
        `⚠️ Changes in critical directory: ${dir} (${diffStats.byDirectory[dir].files} files, ${diffStats.byDirectory[dir].lines} lines)`
      );
    }
  }

  return { level, warnings };
}

/**
 * Generate pre-merge report markdown
 */
export function generateMergeReport(data: MergeReportData): string {
  const { branch, description, completedStories, diffStats, qualityChecks, riskAssessment } = data;

  let report = `# Pre-Merge Report: ${branch}\n\n`;
  report += `**Generated:** ${data.generatedAt}\n\n`;
  report += `**Description:** ${description}\n\n`;

  // Completed User Stories
  report += `## Completed User Stories\n\n`;
  if (completedStories.length === 0) {
    report += `*No user stories tracked*\n\n`;
  } else {
    for (const story of completedStories) {
      report += `### ${story.id}: ${story.title}\n\n`;
      report += `- **Acceptance Criteria:** ${story.acCompleted}/${story.acCount} completed\n`;
      if (story.evidence) {
        report += `- **Evidence:** ${story.evidence}\n`;
      }
      report += `\n`;
    }
  }

  // Diff Statistics
  report += `## Diff Statistics\n\n`;
  report += `- **Total Lines Changed:** ${diffStats.totalLines}\n`;
  report += `- **Total Files Changed:** ${diffStats.totalFiles}\n\n`;

  if (Object.keys(diffStats.byDirectory).length > 0) {
    report += `### Changes by Directory\n\n`;
    report += `| Directory | Files | Lines |\n`;
    report += `|-----------|-------|-------|\n`;
    const sortedDirs = Object.entries(diffStats.byDirectory).sort(
      ([, a], [, b]) => b.lines - a.lines
    );
    for (const [dir, stats] of sortedDirs) {
      report += `| ${dir} | ${stats.files} | ${stats.lines} |\n`;
    }
    report += `\n`;
  }

  // Quality Checks
  report += `## Quality Checks\n\n`;
  report += `- **Type Check:** ${qualityChecks.typeCheck ? "✅ Passed" : "❌ Failed"}\n`;
  report += `- **Build:** ${qualityChecks.build ? "✅ Passed" : "❌ Failed"}\n`;
  if (qualityChecks.tests !== undefined) {
    report += `- **Tests:** ${qualityChecks.tests ? "✅ Passed" : "❌ Failed"}\n`;
  }
  report += `\n`;

  // Risk Assessment
  report += `## Risk Assessment\n\n`;
  report += `**Risk Level:** ${riskAssessment.level.toUpperCase()}\n\n`;
  if (riskAssessment.warnings.length > 0) {
    report += `### Warnings\n\n`;
    for (const warning of riskAssessment.warnings) {
      report += `${warning}\n\n`;
    }
  } else {
    report += `✅ No risk warnings detected.\n\n`;
  }

  return report;
}

/**
 * Save merge report to worktree root
 */
export function saveMergeReport(
  worktreePath: string,
  branch: string,
  reportContent: string
): string {
  const sanitizedBranch = branch.replace(/[^a-z0-9-]/gi, "-");
  const reportPath = join(worktreePath, `${sanitizedBranch}-merge-report.md`);
  writeFileSync(reportPath, reportContent, "utf-8");
  return reportPath;
}
