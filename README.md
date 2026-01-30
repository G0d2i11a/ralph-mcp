# Ralph MCP

[![npm version](https://badge.fury.io/js/ralph-mcp.svg)](https://www.npmjs.com/package/ralph-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Parallel Ralph loop**: PRD → `ralph_start` → merged. Run multiple PRDs simultaneously in isolated worktrees with auto quality gates and merge.

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

## Features

- **2-Step Workflow** - Just create PRD and run `ralph_start`, everything else is automatic
- **Parallel Execution** - Run 5+ PRDs simultaneously with Claude Code Task tool
- **Git Worktree Isolation** - Each PRD runs in its own worktree, zero conflicts
- **Agent Memory** - Persistent "Progress Log" learns from mistakes across User Stories
- **Context Injection** - Inject project rules (CLAUDE.md) into agent context
- **Auto Quality Gates** - Type check, lint, build before every commit
- **Auto Merge** - Merges to main when all User Stories pass
- **Doc Sync** - Automatically updates TODO.md with completed items
- **Notifications** - Windows Toast when PRD completes

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

## Claude Code Skill Setup (Recommended)

For the best experience, create a skill file that teaches Claude how to use Ralph.

See **[SKILL-EXAMPLE.md](./SKILL-EXAMPLE.md)** for a complete, copy-paste ready skill configuration.

### Quick Setup

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
| `ralph_status` | View all PRD execution status |
| `ralph_get` | Get single PRD details |
| `ralph_update` | Update User Story status (called by agent) |
| `ralph_stop` | Stop execution |
| `ralph_merge` | Merge to main + cleanup worktree |
| `ralph_merge_queue` | Manage serial merge queue |
| `ralph_set_agent_id` | Record Task agent ID |

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
| `autoMerge` | `false` | Auto-merge when all stories pass |
| `notifyOnComplete` | `true` | Show Windows notification on completion |
| `onConflict` | `"agent"` | Conflict resolution: `auto_theirs`, `auto_ours`, `notify`, `agent` |
| `contextInjectionPath` | `undefined` | Optional path to file (e.g. CLAUDE.md) to inject into prompt |

### Example with options

```javascript
ralph_start({
  prdPath: "tasks/prd-feature.md",
  autoMerge: true,           // Auto-merge when done
  notifyOnComplete: true,    // Windows Toast notification
  onConflict: "auto_theirs"  // Prefer main on conflicts
})
```

## Credits

- [Geoffrey Huntley](https://ghuntley.com/) - Original Ralph pattern
- [Anthropic](https://anthropic.com/) - Claude Code & MCP protocol

## License

MIT
