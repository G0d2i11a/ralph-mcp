# Security Policy

## Overview

Ralph MCP is a high-privilege automation tool that executes PRD (Product Requirements Document) tasks autonomously. It creates git worktrees, runs shell commands, and manages code merges. This document outlines the security model, current protections, and recommendations.

## Threat Model

### What Ralph Protects Against

1. **Accidental Data Loss**
   - Git worktree isolation prevents changes from affecting the main branch until explicitly merged
   - State persistence allows recovery from crashes
   - Stagnation detection stops runaway loops

2. **State Corruption**
   - Promise-based locking prevents concurrent state file modifications
   - Version-controlled state format with backward compatibility
   - Atomic file writes

3. **Invalid State Transitions**
   - Explicit state machine with validated transitions
   - Terminal states (`stopped`) prevent accidental restarts

### What Ralph Does NOT Protect Against

1. **Malicious PRD Content**
   - Ralph executes tasks defined in PRD files without sandboxing
   - A malicious PRD could instruct the agent to run arbitrary commands
   - **Mitigation**: Only use PRDs from trusted sources

2. **Credential Exposure**
   - Ralph does not manage secrets; it relies on the environment
   - If `.env` files or credentials are in the worktree, they may be accessible
   - **Mitigation**: Use `.gitignore` and never commit secrets

3. **Network-Based Attacks**
   - Ralph uses stdio transport (no network exposure by default)
   - If exposed via HTTP transport, additional authentication is required

4. **Supply Chain Attacks**
   - Ralph depends on npm packages that could be compromised
   - **Mitigation**: Pin dependencies, use lockfiles, audit regularly

## Current Security Measures

### 1. Worktree Isolation

All PRD executions run in isolated git worktrees:
- Changes are isolated from the main branch
- Failed executions can be cleaned up without affecting main
- Merge requires explicit action

### 2. State Machine Validation

Status transitions are validated:
```
pending → running, stopped
running → completed, failed, stopped, merging
completed → merging, stopped
failed → running (retry), stopped
stopped → (terminal)
merging → completed, failed
```

Invalid transitions throw errors, preventing inconsistent states.

### 3. Stagnation Detection

Automatic circuit breaker for stuck executions:
- **No Progress Threshold**: 3 consecutive loops with no file changes
- **Repeated Error Threshold**: 5 consecutive identical errors
- **Max Loops**: 10 loops per pending story

### 4. Tool Annotations

All tools are annotated with security hints:
- `readOnlyHint`: Safe to call without side effects
- `destructiveHint`: May delete data or cause irreversible changes
- `idempotentHint`: Safe to retry

Destructive tools (`ralph_stop`, `ralph_merge`) are marked accordingly.

### 5. Environment Diagnostics

`ralph_doctor` validates the environment before execution:
- Git repository status
- Node.js version
- Package manager availability
- Worktree support
- Directory permissions

## Data Storage

### Location

State is stored in `~/.ralph/state.json` (configurable via `RALPH_DATA_DIR`).

### Contents

- Execution records (branch, status, timestamps)
- User story progress
- Merge queue

### Permissions

The state file is created with default permissions. For sensitive environments:
```bash
chmod 600 ~/.ralph/state.json
```

## Recommendations

### For Users

1. **Review PRDs Before Execution**
   - Inspect PRD files before running `ralph_start`
   - Ensure acceptance criteria don't include dangerous operations

2. **Use Worktree Isolation**
   - Always use `worktree: true` (default) for isolation
   - Review changes before merging

3. **Monitor Executions**
   - Use `ralph_status` to monitor progress
   - Check `atRisk` count for stagnating executions

4. **Clean Up**
   - Use `ralph_stop --cleanup` to remove worktrees after completion
   - Periodically clean old execution records

### For Deployment

1. **Restrict MCP Access**
   - Only allow trusted clients to connect
   - Use Claude Code's permission system to control tool access

2. **Audit Logs**
   - Ralph logs to stderr; capture these for audit trails
   - Consider adding file-based audit logging for production

3. **Backup State**
   - Periodically backup `~/.ralph/state.json`
   - State loss means losing execution history (not code)

## Reporting Security Issues

If you discover a security vulnerability:

1. **Do NOT** open a public GitHub issue
2. Email the maintainer directly (see package.json)
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact

## Future Improvements

Planned security enhancements:

- [ ] Per-tool allowlist configuration
- [ ] Audit log file with structured events
- [ ] PRD content validation/sanitization
- [ ] Configurable command blocklist
- [ ] State file encryption option

## Version

This security policy applies to Ralph MCP v1.1.x and later.
