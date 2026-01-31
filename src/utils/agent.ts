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
  }>,
  contextInjectionPath?: string,
  loopContext?: {
    loopCount: number;
    consecutiveNoProgress: number;
    consecutiveErrors: number;
    lastError: string | null;
  },
  resumeContext?: string
): string {
  const pendingStories = stories
    .filter((s) => !s.passes)
    .sort((a, b) => a.priority - b.priority);

  if (pendingStories.length === 0) {
    return "All user stories are complete. No action needed.";
  }

  const completedCount = stories.filter((s) => s.passes).length;
  const totalCount = stories.length;

  const storiesText = pendingStories
    .map(
      (s) => `
### ${s.storyId}: ${s.title}
${s.description}

**Acceptance Criteria:**
${s.acceptanceCriteria.map((ac, idx) => `- AC-${idx + 1}: ${ac}`).join("\n")}
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

  // Read knowledge base if it exists (Long-term memory)
  let knowledgeBase = "";
  const knowledgePath = join(worktreePath, "knowledge.md");
  if (existsSync(knowledgePath)) {
    try {
      knowledgeBase = readFileSync(knowledgePath, "utf-8");
    } catch (e) {
      // Ignore read errors
    }
  }

  // Read injected context if provided
  let injectedContext = "";
  if (contextInjectionPath && existsSync(contextInjectionPath)) {
    try {
      injectedContext = readFileSync(contextInjectionPath, "utf-8");
    } catch (e) {
      // Ignore read errors
    }
  }

  // Build loop context warning if stagnation is approaching
  let loopWarning = "";
  if (loopContext) {
    if (loopContext.consecutiveNoProgress >= 2) {
      loopWarning = `\n⚠️ **WARNING**: No file changes detected for ${loopContext.consecutiveNoProgress} consecutive updates. If stuck, try a different approach or mark the story as blocked.\n`;
    }
    if (loopContext.consecutiveErrors >= 3) {
      loopWarning += `\n⚠️ **WARNING**: Same error repeated ${loopContext.consecutiveErrors} times. Consider a different approach.\nLast error: ${loopContext.lastError?.slice(0, 200)}\n`;
    }
  }

  return `You are an autonomous coding agent working on the "${branch}" branch.

## Working Directory
${worktreePath}

## PRD: ${description}
${resumeContext ? `\n## Resume Context\n${resumeContext}\n` : ""}
## Progress
- Completed: ${completedCount}/${totalCount} stories
- Current story: ${pendingStories[0].storyId}
${loopContext ? `- Loop iteration: ${loopContext.loopCount}` : ""}
${loopWarning}
${knowledgeBase ? `## Knowledge Base (Long-term Memory)\n${knowledgeBase}\n` : ""}
${injectedContext ? `## Project Context\n${injectedContext}\n` : ""}

${progressLog ? `## Progress & Learnings\n${progressLog}\n` : ""}

## Pending User Stories
${storiesText}

## Story Size Check (CRITICAL)

Before implementing, verify the story is small enough to complete in ONE context window.

**Right-sized stories:**
- Add a database column and migration
- Add a UI component to an existing page
- Update a server action with new logic
- Add a filter dropdown to a list

**Too big (should have been split):**
- "Build the entire dashboard" → schema, queries, UI components, filters
- "Add authentication" → schema, middleware, login UI, session handling
- "Refactor the API" → one story per endpoint

**If a story seems too big:** Complete what you can, commit it, then call \`ralph_update\` with \`passes: false\` and notes explaining what remains. Do NOT produce broken code trying to finish everything.

## Instructions

1. Work on ONE user story at a time, starting with the highest priority.
2. ${progressLog ? "Review the 'Progress & Learnings' section above - especially the 'Codebase Patterns' section at the top." : "Check if 'ralph-progress.md' exists and review it for context."}
3. Implement the feature to satisfy all acceptance criteria.
4. Run quality checks: \`pnpm check-types\` and \`pnpm build\` (adjust for repo structure).
5. **Testing**: Run relevant tests. For UI changes, run component tests if available. If no browser tools are available, note "Manual UI verification needed" in your update notes.
6. Commit changes with message: \`feat: [${pendingStories[0].storyId}] - ${pendingStories[0].title}\`
7. **Update Directory CLAUDE.md**: If you discovered reusable patterns, add them to the CLAUDE.md in the directory you modified (create if needed). Only add genuinely reusable knowledge, not story-specific details.
8. Call \`ralph_update\` with structured status and **evidence**. Include:
   - \`passes: true\` if story is complete, \`passes: false\` if blocked/incomplete
   - \`typecheckPassed: true\` (REQUIRED for passes: true) - Run \`pnpm check-types\`
   - \`buildPassed: true\` (REQUIRED for passes: true) - Run \`pnpm build\`
   - \`filesChanged\`: number of files modified (for stagnation detection)
   - \`error\`: error message if stuck (for stagnation detection)
   - \`acEvidence\`: Per-AC evidence mapping (see format below)
   - \`notes\`: detailed implementation notes

   **Evidence Format:**
   \`\`\`json
   {
     "AC-1": {
       "passes": true,
       "evidence": "Added migration file db/migrations/001_add_column.sql",
       "command": "pnpm db:migrate",
       "output": "Migration applied successfully"
     },
     "AC-2": {
       "passes": true,
       "evidence": "Updated UserService.ts to handle new field",
       "command": "pnpm check-types",
       "output": "No type errors"
     },
     "AC-3": {
       "passes": false,
       "blockedReason": "Waiting for API endpoint to be deployed"
     }
   }
   \`\`\`

   Example:
   \`\`\`
   ralph_update({
     branch: "${branch}",
     storyId: "${pendingStories[0].storyId}",
     passes: true,
     typecheckPassed: true,
     buildPassed: true,
     filesChanged: 5,
     acEvidence: {
       "AC-1": { passes: true, evidence: "...", command: "...", output: "..." },
       "AC-2": { passes: true, evidence: "...", command: "...", output: "..." }
     },
     notes: "**Implemented:** ... **Files changed:** ... **Learnings:** ..."
   })
   \`\`\`
9. Continue to the next story until all are complete.

## Notes Format for ralph_update

Provide structured learnings in the \`notes\` field:
\`\`\`
**Implemented:** Brief summary of what was done
**Files changed:** List key files
**Learnings:**
- Patterns discovered (e.g., "this codebase uses X for Y")
- Gotchas encountered (e.g., "don't forget to update Z when changing W")
- Useful context for future iterations
**Codebase Pattern:** (if discovered a general pattern worth consolidating)
\`\`\`

## Quality Requirements (Feedback Loops)
- **HARD REQUIREMENTS for passes: true:**
  - \`pnpm check-types\` must pass (provide typecheckPassed: true)
  - \`pnpm build\` must pass (provide buildPassed: true)
  - Each AC must have evidence (command output, file paths, test results)
- ALL commits must pass typecheck and build - broken code compounds across iterations
- Run relevant tests before committing
- Keep changes focused and minimal
- Follow existing code patterns
- Do NOT commit broken code - if checks fail, fix before committing

## Stagnation Prevention
- If you're stuck on the same error 3+ times, try a different approach
- If no files are changing, you may be in a loop - step back and reassess
- It's OK to mark a story as \`passes: false\` with notes explaining the blocker

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
