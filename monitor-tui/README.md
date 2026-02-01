# Ralph Monitor TUI

Terminal UI for monitoring Ralph MCP executions in real-time.

## Features

- **Real-time Monitoring**: Auto-refreshes when state changes
- **Overview Dashboard**: See all PRD execution stats at a glance
- **Expandable List**: View User Story progress for each PRD
- **Live Logs**: See latest execution activity
- **Keyboard Navigation**: Vi-style keys supported

## Installation

```bash
cd monitor-tui
npm install
npm run build

# Optional: Install globally
npm link
```

## Usage

```bash
# Run from source
npm run dev

# Or if installed globally
ralph-monitor
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `q` or `Ctrl+C` | Quit |
| `r` | Refresh manually |
| `Space` or `Enter` | Expand/collapse PRD details |
| `↑` / `↓` or `j` / `k` | Navigate list |
| Mouse scroll | Scroll logs |

## UI Layout

```
┌─────────────────────────────────────────────────┐
│ Ralph MCP Monitor                               │
│ PRDs: 2 completed | 1 running | 0 failed        │
│ Stories: 8/12 (67%)                             │
└─────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────┐
│ ▼ 🔄 prd-auth [2/3]                             │
│     ✓ US-001: Database Schema                   │
│     ✓ US-002: Registration API                  │
│     ▶ US-003: Login Flow                        │
│ ▶ ✅ prd-dashboard [5/5]                        │
└─────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────┐
│ [prd-auth] US-003: running                      │
│   Implementing login endpoint...                │
└─────────────────────────────────────────────────┘
 [q]uit [r]efresh [space]expand [↑↓]navigate
```

## How It Works

1. Monitors `~/.ralph/state.json` for changes
2. Auto-refreshes UI when state updates
3. Fallback polling every 5 seconds
4. Lightweight and runs in any terminal

## Requirements

- Node.js 18+
- Terminal with Unicode support (for icons)

## License

MIT
