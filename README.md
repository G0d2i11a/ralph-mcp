# Ralph MCP

[![npm version](https://badge.fury.io/js/ralph-mcp.svg)](https://www.npmjs.com/package/ralph-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Parallel Ralph loop**: PRD → `ralph_start` → **keep chatting** → merged. Run multiple PRDs simultaneously in isolated worktrees with auto quality gates and merge.

Based on [Geoffrey Huntley's Ralph pattern](https://ghuntley.com/ralph/).

[中文文档](./README.zh-CN.md)

## The Ralph Loop (2 Steps)

```
Step 1: Generate PRD
User: "Create a PRD for user authentication"
Claude: [Generates tasks/prd-auth.md]

Step 2: Execute
User: "Start" or "Execute this PRD"
Claude: ralph_start → Task Agent handles everything automatically
```

**That's it.** Ralph MCP automatically handles: branch creation, worktree isolation, code implementation, quality checks, commits, merge, and doc sync.

## Why Ralph MCP?

| Without Ralph | With Ralph |
|---------------|------------|
| One feature at a time | Multiple features in parallel |
| Manual PRD writing | Claude generates PRD for you |
| Manual git branch management | Automatic worktree isolation |
| Lost progress on restart | Persistent state (JSON) |
| Manual merge coordination | Auto merge with conflict resolution |
| No visibility into progress | Real-time status tracking |
| Blocked while waiting | **Keep chatting** while agents work |

## Improvements Over Original Ralph

Ralph MCP extends [snarktank/ralph](https://github.com/snarktank/ralph) with production-grade automation while preserving its core strengths.

### What's New

| Feature | Original Ralph | Ralph MCP |
|---------|---------------|-----------|
| **Agent Lifecycle** | One process per User Story | One long-lived agent per PRD |
| **Execution Model** | Manual script invocation | Background Runner + MCP integration |
| **Parallel PRDs** | Sequential only | 5+ PRDs simultaneously |
| **Dependency Management** | Manual coordination | Auto-triggered when dependencies complete |
| **Stagnation Detection** | None | Auto-detects stuck agents, marks as failed |
| **Agent Memory** | None | Progress Log persists learnings across stories |
| **Merge Coordination** | Manual | Serial merge queue with conflict resolution |
| **Notifications** | None | Windows Toast on completion |
| **Claude Code Integration** | Requires wrapper scripts | Native MCP tools (`ralph_start`, `ralph_status`, etc.) |

### What's Preserved

Ralph MCP keeps the battle-tested foundations:

- **PRD-Driven Development** - Structured requirements with User Stories and Acceptance Criteria
- **Iterative Execution** - One User Story at a time with quality gates
- **Git Worktree Isolation** - Zero conflicts between parallel features
- **Quality Gates** - Type check, lint, build before every commit
- **Automatic Merge** - Hands-free integration when all stories pass

### Key Architectural Changes

1. **Long-Lived Agents**: One agent completes all User Stories in a PRD (not spawning new processes per story)
2. **Runner Automation**: Background process manages execution lifecycle, no manual script running
3. **MCP Native**: Direct integration with Claude Code via MCP protocol
4. **State Persistence**: JSON-based state survives restarts and enables parallel execution tracking

## Features

- **2-Step Workflow** - Just create PRD and run `ralph_start`, everything else is automatic
- **Parallel Execution** - Run 5+ PRDs simultaneously with long-lived Ralph agents
- **CLI-First Agent Runtime** - Default to CLI execution, with SDK fallback still available
- **Git Worktree Isolation** - Each PRD runs in its own worktree, zero conflicts
- **Dependency Management** - PRDs can depend on other PRDs, auto-triggered when dependencies complete
- **Stagnation Detection** - Auto-detects stuck agents (no progress, repeated errors) and marks as failed
- **Agent Memory** - Persistent "Progress Log" learns from mistakes across User Stories

## Agent Support

Ralph MCP splits agent execution into two dimensions:

- `agent.backend`: `cli` (default) or `sdk`
- `agent.provider`: `codex` (default) or `claude`

The runner now prefers CLI launchers by default, and can fall back to the SDK backend when a CLI launch fails.

### Codex CLI (Default)

Uses GPT-5.3 Codex via the Codex CLI for agent execution.

**Requirements:**
- Codex CLI installed
- LiteLLM proxy running on `localhost:4000`
- Environment variables:
  ```bash
  export OPENAI_BASE_URL=http://localhost:4000/v1
  export OPENAI_API_KEY=<your-litellm-master-key>
  ```

**Configuration:**
```yaml
# .ralph.yaml
agent:
  backend: cli
  provider: codex
  coAuthor: "GPT-5.3 Codex <noreply@openai.com>"
  
  codex:
    # Path to Codex CLI (default: "codex")
    codexPath: "codex"
    
    # Approval policy for command execution
    # Options: never, on-request, on-failure, untrusted
    approvalPolicy: on-request
    
    # Sandbox mode for filesystem access
    # Options: read-only, workspace-write, danger-full-access
    sandboxMode: workspace-write
    
    # Execution level (L1=Executor, L2=Builder, L3=Autonomous, L4=Specialist)
    level: L2
    
    # Max auto-recovery attempts when stalled
    maxRecoveryAttempts: 2
    
    # Minutes of inactivity before detecting stall
    stallTimeoutMinutes: 5
```

### Claude CLI

Uses Claude Code CLI directly when you want the CLI backend but prefer Claude as the provider.

**Requirements:**
- Claude Code CLI installed
- LiteLLM proxy running on `localhost:4000` (optional, for custom models)

**Configuration:**
```yaml
# .ralph.yaml
agent:
  backend: cli
  provider: claude
  coAuthor: "Claude Opus 4.6 <noreply@anthropic.com>"

  claude:
    claudePath: claude
    additionalFlags: []
```

### SDK Backend (Fallback / Override)

If you prefer the in-process SDK path, or want a stable fallback when CLI launchers are unavailable, switch `agent.backend` to `sdk`.

```yaml
agent:
  backend: sdk
  provider: claude # or codex
```

### Comparison

| Dimension | Claude | Codex |
|-----------|--------|-------|
| **CLI Command** | `claude` | `codex` |
| **SDK Backend** | Supported | Supported |
| **Approval Policy** | Skip permissions / CLI flags | Configurable |
| **Sandbox Mode** | CLI-managed | Configurable |
| **Best For** | Claude Code workflows | Codex-first automation |

### Switching Agents

To switch providers or backends, update your `.ralph.yaml`:

```yaml
# Use Claude CLI
agent:
  backend: cli
  provider: claude

# Use Codex CLI (default)
agent:
  backend: cli
  provider: codex

# Use Claude SDK instead
agent:
  backend: sdk
  provider: claude
```

Then restart the Ralph MCP server or run `ralph_doctor` to verify configuration.

## Why Long-Lived Agents?

Ralph MCP's long-lived agent design differs from the original Ralph pattern. This section explains the reasoning behind both approaches.

### Original Ralph Philosophy

Geoffrey Huntley designed Ralph with a clear constraint in mind: **context window limits** (~170k tokens at the time). His philosophy:

- **One User Story per agent process** - Each story gets a fresh agent with focused context
- **Avoid multi-agent complexity** - No inter-agent communication or coordination overhead
- **Fast feedback loops** - Quick iterations without context bloat
- **Simple orchestration** - Script-based execution, easy to understand and debug

This design was optimal for the constraints of 2024: limited context windows meant doing one thing well was better than trying to do everything at once.

### Why Ralph MCP Changed This

Ralph MCP adopts long-lived agents (one agent per PRD) because the constraints have evolved:

**1. Larger Context Windows (200k+ tokens)**
- Modern Claude models can handle entire PRDs with multiple User Stories
- Context window is no longer the bottleneck for multi-story execution

**2. Learning Accumulation**
- Progress Log persists learnings across User Stories within the same PRD
- Later stories benefit from discoveries made in earlier stories
- Example: "US-001 found that `pnpm db:migrate:dev` must run after schema changes" → US-003 knows this upfront

**3. Reduced Startup Overhead**
- Spawning a new agent process per story adds latency (model loading, context injection)
- Long-lived agents amortize this cost across all stories in a PRD

**4. Context Continuity**
- Agent remembers architectural decisions from previous stories
- No need to re-explain project structure or conventions for each story
- Natural conversation flow: "continue with the same approach from US-002"

### Trade-offs Comparison

| Aspect | Original Ralph | Ralph MCP |
|--------|---------------|-----------|
| **Context Window** | 170k tokens | 200k+ tokens |
| **Agent Lifecycle** | Short (per User Story) | Long (per PRD) |
| **Learning Accumulation** | None (fresh start each story) | Progress Log persists across stories |
| **Startup Overhead** | High (every story) | Low (once per PRD) |
| **Context Continuity** | None (stateless) | Full (agent remembers previous stories) |
| **Complexity** | Simple (script-based) | Moderate (background runner + state management) |
| **Best For** | Small context windows, simple PRDs | Large context windows, multi-story PRDs |

### When to Use Each Approach

**Original Ralph** is better when:
- Context window is limited (<200k tokens)
- PRDs are simple (1-3 User Stories)
- You prefer script-based simplicity over automation
- Each User Story is independent with no shared learnings

**Ralph MCP** is better when:
- Context window is large (200k+ tokens)
- PRDs are complex (5+ User Stories)
- You want parallel execution of multiple PRDs
- Later stories benefit from earlier discoveries
- You need background execution with state persistence

### Design Philosophy

Both approaches respect the same core principle: **structured, iterative execution with quality gates**. The difference is in how they manage agent lifecycle:

- **Original Ralph**: "Do one thing well, then exit" (optimal for 2024 constraints)
- **Ralph MCP**: "Do all related things in one session" (optimal for 2025+ capabilities)

Ralph MCP doesn't replace the original pattern—it extends it for environments where context windows and automation infrastructure support longer-lived agents.
- **Context Injection** - Inject project rules (CLAUDE.md) into agent context
- **Auto Quality Gates** - Type check, lint, build before every commit
- **Auto Merge** - Merges to main when all User Stories pass
- **Merge Queue** - Serial merge queue to avoid conflicts
- **Notifications** - Windows Toast when PRD completes

## Progress Log (Agent Memory)

Ralph maintains a `ralph-progress.md` file in each worktree that persists learnings across User Stories. This gives agents "memory" of what worked and what didn't.

### How it works

1. When an agent completes a User Story, it records learnings in the `notes` field of `ralph_update`
2. Ralph appends these notes to `ralph-progress.md` in the worktree
3. When the next User Story starts, the agent receives this log in its prompt
4. The file is automatically git-ignored (via `.git/info/exclude`)

### Example progress log

```markdown
## [2024-01-15 14:30] US-001: Setup Database Schema
- Used Prisma with PostgreSQL
- Added index on `userId` for faster queries
- Note: Must run `pnpm db:migrate:dev` after schema changes

## [2024-01-15 15:45] US-002: User Registration API
- Reused validation patterns from existing auth module
- BCrypt rounds set to 12 for password hashing
- Integration test requires test database to be running
```

This allows later stories to benefit from earlier discoveries without re-learning.

## Installation

### From npm

```bash
npm install -g ralph-mcp
```

### From source

```bash
git clone https://github.com/G0d2i11a/ralph-mcp.git
cd ralph-mcp
npm install
npm run build
```

## Configuration

Add to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "ralph": {
      "command": "npx",
      "args": ["ralph-mcp"]
    }
  }
}
```

Or if installed from source:

```json
{
  "mcpServers": {
    "ralph": {
      "command": "node",
      "args": ["/path/to/ralph-mcp/dist/index.js"]
    }
  }
}
```

Restart Claude Code to load.

### Runner backend defaults

- `ralph-runner` now resolves backend and provider separately
- Default behavior is `agent.backend: cli` with `agent.provider: codex`
- When a CLI launch fails, the runner can fall back to the SDK backend
- Set `agent.backend: sdk` to force the SDK path for a project

Copy `examples/ralph.config.example.yaml` to `.ralph.yaml` in your project, or to `~/.ralph/config.yaml` for a global default:

```yaml
agent:
  backend: cli
  provider: codex
  codex:
    codexPath: codex
    approvalPolicy: never
    sandboxMode: workspace-write
    level: L2

# Optional: switch the runner to Claude CLI instead
# agent:
#   backend: cli
#   provider: claude

# Optional: force the SDK backend instead
# agent:
#   backend: sdk
#   provider: claude
```

## Claude Code Skill Setup (Recommended)

For the best experience, create a skill file that teaches Claude how to use Ralph.

See **[SKILL-EXAMPLE.md](./SKILL-EXAMPLE.md)** for a complete, copy-paste ready skill configurationQuick Setup

```bash
# 1. Create skill directory
mkdir -p .claude/skills/ralph

# 2. Copy the example (adjust path as needed)
cp /path/to/ralph-mcp/SKILL-EXAMPLE.md .claude/skills/ralph/SKILL.md

# 3. Customize quality check commands for your project
```

### Add to CLAUDE.md (optional)

```markdown
## Skills

| Skill | Trigger |
|-------|---------|
| `ralph` | PRD execution (generate PRD → start → auto merge) |
```

This enables Claude to automatically use Ralph when you mention PRD execution.

## Tools

| Tool | Description |
|------|-------------|
| `ralph_start` | Start PRD execution (parse PRD, create worktree, return agent prompt) |
| `ralph_batch_start` | Start multiple PRDs with dependency resolution |
| `ralph_status` | View all PRD execution status |
| `ralph_get` | Get single PRD details |
| `ralph_update` | Update User Story status (called by agent) |
| `ralph_stop` | Stop execution |
| `ralph_merge` | Merge to main + cleanup worktree |
| `ralph_merge_queue` | Manage serial merge queue |
| `ralph_set_agent_id` | Record agent task ID |
| `ralph_retry` | Retry a failed PRD execution |
| `ralph_reset_stagnation` | Reset stagnation counters after manual interion |

## Usage

### Typical Session

```
User: Help me finish the Speaking module from TODO.md

Claude: Let me check TODO.md... Found 3 incomplete items:
  - Speaking dialogue practice
  - Speaking scoring optimization
  - Speaking question bank

I'll create 3 PRDs...
[Generates prd-speaking-dialogue.md]
[Generates prd-speaking-scoring.md]
[Generates prd-speaking-qb.md]

User: Start

Claude:
[ralph_start × 3]
[Task Agent × 3 running in parallel]

3 PRDs started. They'll auto-merge when complete.
Use ralph_status to check progress.

--- Some time later ---

User: Progress?

Claude: [ralph_status]
✅ prd-speaking-dialogue - Merged
✅ prd-speaking-scoring - Merged
🔄 prd-speaking-qb - US-003/005 in progress

User: 👍
```

### Manual Workflow

```javascript
// 1. Start PRD execution
ralph_start({ prdPath: "tasks/prd-feature.md" })

// 2. Check status anytime
ralph_status()

// 3. Manual merge if needed (usually automatic)
ralph_merge({ branch: "ralph/prd-feature" })
```

### API Reference

```javascript
// Start PRD execution (returns agent prompt)
ralph_start({ prdPath: "tasks/prd-feature.md" })

// Start multiple PRDs in parallel
ralph_batch_start({ prdPaths: ["tasks/prd-a.md", "tasks/prd-b.md"] })

// View all PRD status
ralph_status()

// Get single PRD details
ralph_get({ branch: "ralph/prd-feature" })

// Update User Story status (called by agent)
ralph_update({ branch: "ralph/prd-feature", storyId: "US-1", passes: true, notes: "..." })

// Stop execution
ralph_stop({ branch: "ralph/prd-feature" })

// Merge to main
ralph_merge({ branch: "ralph/prd-feature" })

// Record Task agent ID (for tracking)
ralph_set_agent_id({ branch: "ralph/prd-feature", agentTaskId: "abc123" })

// Retry a failed execution
ralph_retry({ branch: "ralph/prd-feare" })

// Reset stagnation counters (after manual fix)
ralph_reset_stagnation({ branch: "ralph/prd-feature" })
```

## PRD Format

Ralph parses markdown PRD files. Example:

```markdown
---
title: User Authentication
priority: high
---

# User Authentication

Implement user login and registration.

## User Stories

### US-1: User Registration

Users can create new accounts.

**Acceptance Criteria:**
- [ ] Email validation
- [ ] Password strength check
- [ ] Confirmation email sent

### US-2: User Login

Users can log into their accounts.

**Acceptance Criteria:**
- [ ] Email/password authentication
- [ ] Remember me option
- [ ] Forgot password flow
```

## Conflict Resolution

`ralph_merge` supports these strategies:

| Strategy | Behavior |
|----------|----------|
| `auto_theirs` | `git merge -X theirs`, prefer main |
| `auto_ours` | `git merge -X ours`, prefer branch |
| `notify` | Pause, notify user to resolve manually |
| `agent` | Launch merge subagent to resolve (default) |

## Data Storage

- State: `~/.ralph/state.json`
- Logs: `~/.ralph/logs/`

Override data directory with `RALPH_DATA_DIR` environment variable.

## Advanced Options

### ralph_start options

| Option | Default | Description |
|--------|---------|-------------|
| `prdPath` | required | Path to PRD markdown file |
| `projectRoot` | cwd | Project root directory |
| `worktree` | `true` | Create isolated git worktree |
| `autoStart` | `true` | Return agent prompt for immediate execution |
| `autoMerge` | `true` | Auto add to merge queue when all stories pass |
| `notifyOnComplete` | `true` | Show Windows notification on completion |
| `onConflict` | `"agent"` | Conflict resolution: `auto_theirs`, `auto_ours`, `notify`, `agent` |
| `contextInjectionPath` | `undefined` | Optionalfile (e.g. CLAUDE.md) to inject into prompt |
| `ignoreDependencies` | `false` | Skip dependency check and start even if dependencies are not satisfied |
| `queueIfBlocked` | `false` | If dependencies are not satisfied, create a pending execution instead of failing |

### Example with options

```javascript
ralph_start({
  prdPath: "tasks/prd-feature.md",
  autoMerge: true,           // Auto-merge when done
  notifyOnComplete: true,    // Windows Toast notification
  onConflict: "auto_theirs"  // Prefer main on conflicts
})
```

### ralph_batch_start options

Start multiple PRDs with dependency resolution and serial `pnpm install`.

| Option | Default | Description |
|--------|---------|-------------|
| `prdPaths` | required | Array of paths to PRD markdown files |
| `projectRoot` | cwd | Project root directory |
| `worktree` | `true` | Create worktrees for isolation |
| `autoMerge` | `true` | Auto add to merge queue when all stories pass |
| `notifyOnComplete` | `true` | Show Windows notification on completion |
| `onConflict` | `"agent"` | Conflict resolution strategy |
| `contextInjectionPath` | `undefined` | Path to file (e.g. CLAUDE.md) to inject into prompt |
heat` | `true` | Run pnpm install serially beforeting agents |

```javascript
ralph_batch_start({
  prdPaths: [
    "tasks/prd-auth.md",
    "tasks/prd-dashboard.md",
    "tasks/prd-settings.md"
  ],
  contextInjectionPath: "CLAUDE.md",
  autoMerge: true
})
```

### ralph_retry

Retry a failed PRD execution. Resets stagnation counters and generates a new agent prompt to continue from where it left off.

```javascript
// Retry a failed execution
ralph_retry({ branch: "ralph/prd-feature" })
// Returns: { success, branch, message, previousStatus, agentPrompt, progress }
```

### ralph_reset_stagnation

Reset stagnation counters after manual intervention. Use when you've fixed an issue and want the agent to continue.

| Option | Default | Description |
|--------|---------|-------------|
| `branch` | required | Branch name |
| `resumeExecution` | `true` | Also set status back to 'running' if currently 'failed' |

```javascript
// Reset counters and resume
ralph_reset_stagnation({ branch: "ralph/prd-feature" })

// Reset counters only (keep failed status)
ralph_reset_stagnation({ branch: "ralph/prd-feature", resumeExecution: false })
```

## Recent Improvements

### 2026-03-06
- **Verified completedUS skip logic**: Confirmed that ralph-mcp's database-driven architecture automatically skips completed User Stories via `stories.filter((s) => !s.passes)` in agent prompt generation. Unlike ralph-cli which required manual `completedUS.includes()` checks, ralph-mcp's design inherently prevents re-execution of completed stories.
- Fixed progress detection false positives
- Added commit count tracking to distinguish real progress from stagnation
- Prevents agents from being marked as stagnant after successfully committing code

## Credits

- [Geoffrey Huntley](https://ghuntley.com/) - Original Ralph pattern
- [Anthropic](https://anthropic.com/) - Claude Code & MCP protocol

## License

MIT
