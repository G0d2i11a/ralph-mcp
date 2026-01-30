import { exec } from "child_process";
import { promisify } from "util";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const execAsync = promisify(exec);

/**
 * Generate agent prompt for PRD execution
 */
export function generateAgentPrompt(
  branch: string,
  description: string,
  worktreePath: string,
  stories: Array<{
    storyId: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    priority: number;
    passes: boolean;
  }>
): string {
  const pendingStories = stories
    .filter((s) => !s.passes)
    .sort((a, b) => a.priority - b.priority);

  if (pendingStories.length === 0) {
    return "All user stories are complete. No action needed.";
  }

  const storiesText = pendingStories
    .map(
      (s) => `
### ${s.storyId}: ${s.title}
${s.description}

**Acceptance Criteria:**
${s.acceptanceCriteria.map((ac) => `- ${ac}`).join("\n")}
`
    )
    .join("\n");

  // Read progress log if it exists
  let progressLog = "";
  const progressPath = join(worktreePath, "ralph-progress.md");
  if (existsSync(progressPath)) {
    try {
      progressLog = readFileSync(progressPath, "utf-8");
    } catch (e) {
      // Ignore read errors
    }
  }

  return `You are an autonomous coding agent working on the "${branch}" branch.

## Working Directory
${worktreePath}

## PRD: ${description}

${progressLog ? `## Progress & Learnings\n${progressLog}\n` : ""}

## Pending User Stories
${storiesText}

## Instructions

1. Work on ONE user story at a time, starting with the highest priority.
2. ${progressLog ? "Review the 'Progress & Learnings' section above to understand previous decisions and context." : "Check if 'ralph-progress.md' exists and review it for context."}
3. Implement the feature to satisfy all acceptance criteria.
4. Run quality checks: \`pnpm check-types\` and \`pnpm --filter api build\` (adjust command for the specific repo structure if needed).
5. Commit changes with message: \`feat: [${pendingStories[0].storyId}] - ${pendingStories[0].title}\`
6. After completing a story, call \`ralph_update\` to mark it as passed:
   \`ralph_update({ branch: "${branch}", storyId: "${pendingStories[0].storyId}", passes: true, notes: "Brief summary of implementation, key decisions, and any learnings." })\`
7. Continue to the next story until all are complete.

## Quality Requirements
- ALL commits must pass typecheck and build
- Keep changes focused and minimal
- Follow existing code patterns

## Stop Condition
When all stories are complete, report completion.
`;
}

/**
 * Generate merge agent prompt for conflict resolution
 */
export function generateMergeAgentPrompt(
  projectRoot: string,
  branch: string,
  description: string,
  conflictFiles: string[],
  prdPath?: string
): string {
  // Read CLAUDE.md for architecture context
  let architectureContext = "";
  const claudeMdPath = join(projectRoot, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    architectureContext = readFileSync(claudeMdPath, "utf-8");
  }

  // Read PRD content if available
  let prdContent = "";
  if (prdPath && existsSync(prdPath)) {
    prdContent = readFileSync(prdPath, "utf-8");
  }

  return `You are a Git merge expert. Please resolve the following merge conflicts.

## Project Architecture
${architectureContext || "No CLAUDE.md found. Use your best judgment based on the code."}

## PRD Context
${prdContent || `Branch: ${branch}\nDescription: ${description}`}

## Conflict Files
${conflictFiles.map((f) => `- ${f}`).join("\n")}

## Tasks

1. Read each conflict file to understand both sides of the conflict
2. Analyze the intent of changes from both branches based on the PRD
3. Resolve conflicts by keeping valuable changes from both sides
4. Ensure the PRD requirements are satisfied
5. Run \`git add <file>\` for each resolved file
6. Run \`git commit -m "resolve: merge conflicts for ${branch}"\`

## Guidelines
- Prefer keeping both changes when they don't conflict logically
- If changes conflict logically, prefer the feature branch changes (they implement the PRD)
- Ensure the code compiles after resolution
- Run \`pnpm check-types\` to verify
`;
}

/**
 * Start a Claude agent via CLI (for merge conflicts)
 */
export async function startMergeAgent(
  projectRoot: string,
  prompt: string
): Promise<{ success: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execAsync(
      `echo "${prompt.replace(/"/g, '\\"')}" | claude --dangerously-skip-permissions --print`,
      { cwd: projectRoot, maxBuffer: 10 * 1024 * 1024 }
    );
    return { success: true, output: stdout || stderr };
  } catch (error) {
    return {
      success: false,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}
