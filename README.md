# Ralph MCP

[![npm version](https://badge.fury.io/js/ralph-mcp.svg)](https://www.npmjs.com/package/ralph-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

MCP server for autonomous PRD execution with Claude Code. Git worktree isolation, progress tracking, auto-merge.

Based on [Geoffrey Huntley's Ralph pattern](https://ghuntley.com/ralph/).

[中文文档](./README.zh-CN.md)

## Features

- **PRD Parsing** - Extracts User Stories from markdown PRD files
- **Git Worktree Isolation** - Each PRD runs in isolated worktree
- **Background Execution** - Works with Claude Code's Task tool for parallel PRD execution
- **Progress Tracking** - Real-time status via `ralph_status()`
- **Auto Merge** - One-click merge with conflict resolution
- **Notifications** - Windows Toast when PRD completes
- **State Persistence** - Survives Claude Code restarts (JSON storage)

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

### Basic Workflow

```javascript
// 1. Start PRD execution
ralph_start({ prdPath: "tasks/prd-feature.md" })

// 2. Check status anytime
ralph_status()

// 3. Merge when complete
ralph_merge({ branch: "ralph/prd-feature" })
```

### Parallel Execution with Claude Code Task Tool

Ralph MCP is designed to work with Claude Code's Task tool for parallel PRD execution:

```
1. Analyze PRDs to identify independent tasks that can run in parallel
2. Start multiple PRDs via ralph_start()
3. Launch background Task agents for each PRD
4. Continue chatting - plan next features, review code, etc.
5. Get Windows Toast notification when PRDs complete
6. Merge completed PRDs to main via ralph_merge()
```

**Example session:**

```
User: Execute these 3 PRDs in parallel

Claude: Let me analyze the PRDs...
        - prd-auth.md (independent)
        - prd-dashboard.md (independent)
        - prd-api.md (independent)

        All 3 can run in parallel. Starting...

        [Calls ralph_start() for each PRD]
        [Launches 3 background Task agents]

        PRDs are running in background. You can continue working.
        I'll notify you when they complete.

User: Great, let's plan the next feature while waiting...

[Later - Windows Toast notification appears]

Claude: All 3 PRDs completed successfully!
        - ralph/prd-auth: 4/4 US ✓
        - ralph/prd-dashboard: 3/3 US ✓
        - ralph/prd-api: 5/5 US ✓

        Ready to merge?

User: Yes, merge all

Claude: [Calls ralph_merge() for each branch]
        All PRDs merged to main successfully.
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
