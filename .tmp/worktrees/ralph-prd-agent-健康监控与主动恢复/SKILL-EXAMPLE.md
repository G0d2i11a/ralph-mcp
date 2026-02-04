# Ralph Skill Example

This is a complete example of `.claude/skills/ralph/SKILL.md` for your project.

Copy this file to your project and customize the quality check commands.

---

# /ralph - Parallel Ralph Loop

Ralph is a 2-step PRD execution system: **Generate PRD → Start Execution → Keep Chatting**.

## Core Concept

**Delegate and continue.** After `ralph_start`, agents work in the background. You can:
- Continue chatting with Claude about other topics
- Start more PRDs in parallel
- Check progress anytime with `ralph_status`

## Core Workflow (2 Steps)

```
Step 1: Generate PRD
User: "Create a PRD for XXX feature"
Claude: Generate tasks/prd-xxx.md

Step 2: Execute
User: "Start" or "Execute this PRD"
Claude: ralph_start → Task Agent handles everything
```

**That's it.** Ralph MCP automatically handles: branch creation, worktree isolation, code implementation, quality checks, commits, merge, and doc sync.

## MCP Tools

| Tool | Purpose |
|------|---------|
| `ralph_start` | Start PRD execution (creates worktree + Task agent) |
| `ralph_batch_start` | Start multiple PRDs with dependency resolution |
| `ralph_status` | View all PRD execution status |
| `ralph_get` | View single PRD detailed progress |
| `ralph_merge` | Manual merge trigger (usually automatic) |
| `ralph_stop` | Stop execution |
| `ralph_retry` | Retry a failed execution |
| `ralph_reset_stagnation` | Reset stagnation counters after manual fix |

## Parallel Execution

Run multiple PRDs simultaneously in isolated worktrees:

```
User: "Execute these 5 PRDs"
Claude:
  ralph_start(prd-a.md)  ─┐
  ralph_start(prd-b.md)  ─┼─→ 5 Task Agents in parallel
  ralph_start(prd-c.md)  ─┤
  ralph_start(prd-d.md)  ─┤
  ralph_start(prd-e.md)  ─┘
```

## PRD Format

PRD files go in `tasks/prd-*.md`:

```markdown
# PRD: Feature Name

## Description
Feature description

## User Stories

### US-001: Story Title
As a user, I want feature, So that value

**Acceptance Criteria:**
- Criterion 1
- Criterion 2
```

## Automation Flow

After `ralph_start`, system automatically:

1. **Parse PRD** → Extract User Stories and acceptance criteria
2. **Create worktree** → `ralph/<feature-name>` branch isolation
3. **Start Task Agent** → Background execution
4. **Implement each US** → Code + quality check + commit
5. **Merge when done** → Auto merge to main
6. **Doc sync** → Update TODO.md with completed items
7. **Cleanup** → Remove worktree

## Status Monitoring

```
User: "PRD progress?"
Claude: ralph_status → Shows all running/completed PRDs
```

## Typical Session

```
User: Help me finish the Auth module from TODO.md

Claude: Let me check TODO.md... Found 3 incomplete items:
  - User registration
  - Password reset
  - OAuth integration

I'll create 3 PRDs...
[Generates prd-user-registration.md]
[Generates prd-password-reset.md]
[Generates prd-oauth.md]

User: Start

Claude:
[ralph_start × 3]
[Task Agent × 3 running in parallel]

3 PRDs started. They'll auto-merge when complete.
Use ralph_status to check progress.

User: While those run, help me debug this API error...  ← Keep chatting!

Claude: [Helps with debugging normally]

User: Progress?

Claude: [ralph_status]
✅ prd-user-registration - Merged
✅ prd-password-reset - Merged
🔄 prd-oauth - US-002/003 in progress

User: Great, now let's work on the dashboard...  ← Continue other work

Claude: [Continues helping with dashboard]
```

## Quality Gates

Customize these commands for your project. Each US runs these before commit:

```bash
# Example for Node.js/TypeScript project
pnpm check-types
pnpm lint
pnpm build

# Example for Python project
pytest
mypy .
ruff check .

# Example for Go project
go build ./...
go test ./...
golangci-lint run
```

No commit if checks fail. No merge if any US fails.

## File Locations

| File | Location |
|------|----------|
| PRD source files | `tasks/prd-*.md` |
| Execution state | Ralph MCP database (`~/.ralph/`) |
| Worktrees | `../<project>-worktrees/<branch>` |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Merge conflict | `ralph_merge --onConflict=agent` lets agent resolve |
| Execution stuck | `ralph_stop` then `ralph_start` again |
| Quality check fails | Agent auto-fixes, stops after multiple failures |

## CLAUDE.md Integration

Add to your project's `CLAUDE.md`:

```markdown
## Skills

| Skill | Trigger |
|-------|---------|
| `ralph` | PRD execution (generate PRD → start → auto merge) |
```
