# Dynamic Concurrency Control for Ralph MCP

## Problem
- Memory explosion when too many Claude agents run in parallel
- state.json corruption from concurrent writes during high load
- No way to adjust concurrency at runtime

## Requirements

### 1. Runtime Concurrency Adjustment
Add MCP tool `ralph_set_concurrency`:
```typescript
{
  maxConcurrent: number,  // 1-10, default 3
  reason?: string         // optional log reason
}
```

Modify `Runner.config.concurrency` at runtime. Take effect on next poll cycle.

### 2. Memory-Based Auto-Scaling
Add to Runner poll cycle:
```typescript
// Check system memory before launching new agents
const freeMemPercent = os.freemem() / os.totalmem() * 100;

if (freeMemPercent < 15) {
  // Critical: pause all new launches
  this.config.concurrency = 0;
  log.warn('Memory critical, pausing launches');
} else if (freeMemPercent < 30) {
  // Low: reduce to 1
  this.config.concurrency = Math.min(this.config.concurrency, 1);
  log.warn('Memory low, reducing concurrency to 1');
}
```

### 3. Safer State File Writes
Current issue: Multiple processes can corrupt state.json.

Fix in `state.ts`:
- Add file-level lock using `proper-lockfile` package
- Retry with exponential backoff on EBUSY/EPERM
- Validate JSON before overwriting (parse test)

### 4. Status Tool Enhancement
Add memory info to `ralph_status` response:
```typescript
{
  // existing fields...
  system: {
    freeMemoryPercent: number,
    effectiveConcurrency: number,
    pausedDueToMemory: boolean
  }
}
```

## Implementation Order
1. `ralph_set_concurrency` tool (quick win)
2. Memory check in poll cycle
3. State file locking
4. Status enhancement

## Files to Modify
- `src/runner.ts` - add setMaxConcurrency(), memory check
- `src/tools/` - add set-concurrency.ts
- `src/store/state.ts` - add proper-lockfile
- `src/tools/status.ts` - add system info
