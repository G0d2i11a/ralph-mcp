import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { AgentInvocationRouter } from "../agent-sdk/router.js";
import type { Provider } from "../agent-sdk/types.js";
import { resolveAgentLaunchConfig, type ResolvedAgentLaunchConfig } from "./launcher.js";

const agentRouter = new AgentInvocationRouter();

function quoteForBash(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")}"`;
}

function getGitBashPath(): string {
  return process.env.CLAUDE_CODE_GIT_BASH_PATH
    || (existsSync("D:\\Software\\Git\\bin\\bash.exe") ? "D:\\Software\\Git\\bin\\bash.exe" : "")
    || (existsSync("C:\\Program Files\\Git\\bin\\bash.exe") ? "C:\\Program Files\\Git\\bin\\bash.exe" : "")
    || "bash.exe";
}

async function collectProcessResult(
  child: ReturnType<typeof spawn>,
  input?: string
): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve({
        success: false,
        output: error.message,
      });
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n");

      resolve({
        success: code === 0,
        output:
          output
          || (code === 0
            ? "Completed without output"
            : `Process exited with code ${code}${signal ? ` (signal: ${signal})` : ""}`),
      });
    });

    if (child.stdin) {
      child.stdin.on("error", () => {});

      if (input) {
        child.stdin.end(input);
      } else {
        child.stdin.end();
      }
    }
  });
}

async function runMergeAgentViaCli(
  projectRoot: string,
  prompt: string,
  config: ResolvedAgentLaunchConfig
): Promise<{ success: boolean; output: string }> {
  if (config.provider === "codex") {
    const child = spawn(
      config.codex.codexPath,
      [
        "--non-interactive",
        "--approval-policy", config.codex.approvalPolicy,
        "--sandbox-mode", config.codex.sandboxMode,
        "--level", config.codex.level,
        "--max-recovery-attempts", String(config.codex.maxRecoveryAttempts),
        "--stall-timeout-minutes", String(config.codex.stallTimeoutMinutes),
        prompt,
      ],
      {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      }
    );

    return collectProcessResult(child);
  }

  const args = [
    "--print",
    "--dangerously-skip-permissions",
    ...config.claude.additionalFlags,
  ];

  const isWindows = process.platform === "win32";
  const gitBashPath = getGitBashPath();

  const child = isWindows
    ? spawn(
      gitBashPath,
      [
        "-c",
        `export CLAUDE_CODE_GIT_BASH_PATH=${quoteForBash(gitBashPath)} && cat | ${quoteForBash(config.claude.claudePath)} ${args.map(quoteForBash).join(" ")}`,
      ],
      {
        cwd: projectRoot,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CLAUDE_CODE_GIT_BASH_PATH: gitBashPath,
        },
      }
    )
    : spawn(config.claude.claudePath, args, {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

  return collectProcessResult(child, prompt);
}

async function runMergeAgentViaSdk(
  projectRoot: string,
  prompt: string,
  provider: Provider,
  config: ResolvedAgentLaunchConfig
): Promise<{ success: boolean; output: string }> {
  const metadata = provider === "codex"
    ? {
      codex: {
        approvalPolicy: config.codex.approvalPolicy,
        sandboxMode: config.codex.sandboxMode,
        level: config.codex.level,
      },
    }
    : undefined;

  const handle = await agentRouter.invoke({
    provider,
    taskKind: "code",
    cwd: projectRoot,
    prompt,
    model: provider === "claude" ? "claude-opus-4-6" : undefined,
    metadata,
  });

  let lastMessage = "";

  for await (const event of handle.events) {
    if (typeof event.message === "string" && event.message.trim().length > 0) {
      lastMessage = event.message;
    }
  }

  const result = await handle.wait();

  if (result.status === "success") {
    return {
      success: true,
      output: result.output || lastMessage,
    };
  }

  return {
    success: false,
    output: result.error || result.output || lastMessage || `Agent ended with status ${result.status}`,
  };
}

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
    acEvidence?: Record<string, { passes: boolean; evidence?: string; command?: string; output?: string; blockedReason?: string }>;
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
      (s) => {
        const acEvidence = s.acEvidence || {};
        const acList = s.acceptanceCriteria.map((ac, idx) => {
          const acKey = `AC-${idx + 1}`;
          const evidence = acEvidence[acKey];
          const status = evidence?.passes ? "[x]" : "[ ]";
          return `- ${status} AC-${idx + 1}: ${ac}${evidence?.passes ? ` (completed)` : ""}`;
        }).join("\n");

        return `
### ${s.storyId}: ${s.title}
${s.description}

**Acceptance Criteria:**
${acList}
`;
      }
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
      loopWarning = `\n[!] **WARNING**: No file changes detected for ${loopContext.consecutiveNoProgress} consecutive updates. If stuck, try a different approach or mark the story as blocked.\n`;
    }
    if (loopContext.consecutiveErrors >= 3) {
      loopWarning += `\n[!] **WARNING**: Same error repeated ${loopContext.consecutiveErrors} times. Consider a different approach.\nLast error: ${loopContext.lastError?.slice(0, 200)}\n`;
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
- "Build the entire dashboard" -> schema, queries, UI components, filters
- "Add authentication" -> schema, middleware, login UI, session handling
- "Refactor the API" -> one story per endpoint

**If a story seems too big:** Complete what you can, commit it, then call \`ralph_update\` with \`passes: false\` and notes explaining what remains. Do NOT produce broken code trying to finish everything.

## Instructions

1. Work on ONE user story at a time, starting with the highest priority.
2. ${progressLog ? "Review the 'Progress & Learnings' section above - especially the 'Codebase Patterns' section at the top." : "Check if 'ralph-progress.md' exists and review it for context."}
3. **PRE-DECLARATION (REQUIRED)**: Before implementing, declare which files you expect to change:
   \`\`\`json
   { "expectedFiles": ["src/path/to/file1.ts", "src/path/to/file2.ts"] }
   \`\`\`
   This helps catch scope creep and ensures intentional changes.
4. Implement the feature to satisfy all acceptance criteria.
5. Run quality checks: \`pnpm check-types\` and \`pnpm build\` (adjust for repo structure).
6. **Testing**: Run relevant tests. For UI changes, run component tests if available. If no browser tools are available, note "Manual UI verification needed" in your update notes.
7. Commit changes with message: \`feat: [${pendingStories[0].storyId}] - ${pendingStories[0].title}\`
8. **Update Directory CLAUDE.md**: If you discovered reusable patterns, add them to the CLAUDE.md in the directory you modified (create if needed). Only add genuinely reusable knowledge, not story-specific details.
9. Call \`ralph_update\` with structured status and **evidence**. Include:
   - \`passes: true\` if story is complete, \`passes: false\` if blocked/incomplete
   - \`typecheckPassed: true\` (REQUIRED for passes: true) - Run \`pnpm check-types\`
   - \`buildPassed: true\` (REQUIRED for passes: true) - Run \`pnpm build\`
   - \`expectedFiles\`: Array of files you declared in step 3
   - \`unexpectedFileExplanation\`: If you changed files not in expectedFiles, explain why
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
     expectedFiles: ["src/services/user.ts", "src/controllers/user.ts"],
     filesChanged: 5,
     acEvidence: {
       "AC-1": { passes: true, evidence: "...", command: "...", output: "..." },
       "AC-2": { passes: true, evidence: "...", command: "...", output: "..." }
     },
     notes: "**Implemented:** ... **Files changed:** ... **Learnings:** ..."
   })
   \`\`\`

   If you changed unexpected files:
   \`\`\`
   ralph_update({
     ...
     expectedFiles: ["src/services/user.ts"],
     unexpectedFileExplanation: [
       { file: "src/utils/helpers.ts", reason: "Needed to add shared validation function", isNewFile: false }
     ],
     ...
   })
   \`\`\`
10. After completing this ONE story and calling ralph_update, STOP. End your response. Another iteration will pick up the next story.

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
- **DIFF RECONCILIATION (prevents scope creep):**
  - Declare expectedFiles BEFORE implementation (step 3)
  - New files/directories must be declared or explained
  - Changes outside declaration trigger scope guardrail check
  - >50% divergence between declared and actual -> requires re-evaluation
  - unexpectedFileExplanation format: \`[{ file: "path", reason: "why", isNewFile: true/false }]\`
- **SCOPE GUARDRAILS (prevents large changes):**
  - Warn threshold: >1500 lines or >15 files -> must provide scopeExplanation
  - Hard threshold: >3000 lines or >25 files -> story rejected, must split
  - scopeExplanation format: \`[{ file: "path/to/file.ts", reason: "why in scope", lines: 123 }]\`
  - Excluded from count: lock files, snapshots, dist/, build/, .next/
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
After completing ONE user story and calling ralph_update, end your response.\nAnother iteration will start a fresh agent for the next story.\nIf ALL stories are complete after your ralph_update, report completion.
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
 * Start a merge-resolution agent using the configured backend/provider.
 *
 * CLI is attempted first when configured, with SDK kept as a fallback so
 * existing merge-agent flows keep working even if the CLI launch fails.
 */
export async function startMergeAgent(
  projectRoot: string,
  prompt: string
): Promise<{ success: boolean; output: string }> {
  try {
    const config = resolveAgentLaunchConfig(projectRoot);

    if (config.backend === "cli") {
      const cliResult = await runMergeAgentViaCli(projectRoot, prompt, config);
      if (cliResult.success) {
        return cliResult;
      }

      const sdkResult = await runMergeAgentViaSdk(projectRoot, prompt, config.provider, config);
      if (sdkResult.success) {
        return sdkResult;
      }

      return {
        success: false,
        output: `CLI merge agent failed: ${cliResult.output}\n\nSDK fallback failed: ${sdkResult.output}`,
      };
    }

    return runMergeAgentViaSdk(projectRoot, prompt, config.provider, config);
  } catch (error) {
    return {
      success: false,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}
