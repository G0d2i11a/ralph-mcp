# Ralph MCP

[![npm version](https://badge.fury.io/js/ralph-mcp.svg)](https://www.npmjs.com/package/ralph-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

MCP server for autonomous PRD execution with Claude Code. Git worktree isolation, progress tracking, auto-merge.

Based on [Geoffrey Huntley's Ralph pattern](https://ghuntley.com/ralph/).

[中文文档](./README.zh-CN.md)

## Features

- **PRD Parsing** - Extracts User Stories from markdown PRD files
- **Git Worktree Isolation** - Each PRD runs in isolated worktree
- **Progress Tracking** - Real-time status via `ralph_status()`
- **Auto Merge** - One-click merge with conflict resolution
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

```javascript
// Start PRD execution
ralph_start({ prdPath: "tasks/prd-feature.md" })

// Check all status
ralph_status()

// Get single PRD details
ralph_get({ branch: "ralph/prd-feature" })

// Update US status (agent calls this after completing a story)
ralph_update({ branch: "ralph/prd-feature", storyId: "US-1", passes: true, notes: "..." })

// Merge completed PRD
ralph_merge({ branch: "ralph/prd-feature" })
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

## Credits

- [Geoffrey Huntley](https://ghuntley.com/) - Original Ralph pattern
- [Anthropic](https://anthropic.com/) - Claude Code & MCP protocol

## License

MIT
