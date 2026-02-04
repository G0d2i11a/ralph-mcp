# Ralph MCP - 增强反馈与控制（Enhanced Feedback & Control）

## Description

增强 Ralph MCP 的反馈机制和控制能力，包括失败/阻塞策略、US 粒度控制、预合并报告等，提升系统的可观测性和可控性。

## Dependencies

- ralph/prd-ralph-trust-baseline（必须先完成信任基线）
- ralph/prd-ralph-dual-mode（建议先完成，但非强制）

## User Stories

### US-001: 失败/阻塞策略

**描述**：Agent 可以主动标记 US 为 blocked，并提供阻塞原因和建议的解决方案。

**Acceptance Criteria**：
- `ralph_update` 支持 `passes: false` + `blockedReason` 字段
- `blockedReason` 必须是结构化的：`{ "type": "environment|dependency|requirement", "description": "...", "suggestedAction": "..." }`
- 连续失败 3 次（相同错误）→ 自动标记为 blocked
- `ralph_status` 显示 blocked 状态和原因
- `ralph_get` 输出包含所有 blocked US 的详细信息
- Agent prompt 中明确说明：遇到无法解决的问题时应该标记为 blocked 而不是无限重试

**Priority**: 1

### US-002: US 粒度检测

**描述**：PRD 解析时检测"过大 US"，给出拆分建议（但不强制）。

**Acceptance Criteria**：
- 解析 PRD 时分析每个 US 的 AC 数量和描述长度
- 启发式规则：AC > 5 个或描述 > 500 字 → 标记为"可能过大"
- `ralph_start` 输出中显示拆分建议：`"US-003 may be too large (7 AC). Consider splitting into: [建议的拆分方式]"`
- 建议基于 AC 的语义分组（例如：前端 AC vs 后端 AC）
- 不阻止执行，仅作为警告

**Priority**: 2

### US-003: 预合并报告

**描述**：`ralph_merge` 前生成详细报告，包含完成的 US、证据摘要、diff 统计等。

**Acceptance Criteria**：
- `ralph_merge` 执行前生成 `<branch>-merge-report.md`
- 报告包含：
  - 完成的 US 列表（ID + 标题）
  - 每个 US 的 AC 完成情况和证据摘要
  - Diff 统计（总行数、文件数、按目录分组）
  - 质量检查结果（typecheck、build、tests）
  - 风险评估（基于 diff 大小和改动范围）
- 报告保存到 worktree 根目录
- `ralph_merge` 输出中提示报告位置
- 如果有高风险项（diff > 5k 行或 > 50 个文件），在报告中高亮警告

**Priority**: 3

### US-004: 停滞检测增强

**描述**：增强停滞检测逻辑，识别"空转重试"和"无效修改"。

**Acceptance Criteria**：
- 检测"空转重试"：连续 2 次 `ralph_update` 的 `notes` 相似度 > 80% → 警告
- 检测"无效修改"：`filesChanged: 0` 连续出现 2 次 → 警告
- 检测"相同错误"：`error` 字段连续 3 次相同（Levenshtein 距离 < 20%）→ 自动 blocked
- 警告和 blocked 信息记录到 execution 的 `stagnationLog` 字段
- `ralph_status` 显示停滞警告

**Priority**: 4

### US-005: 进度可视化增强

**描述**：`ralph_status` 输出更丰富的进度信息，包括时间线、速度、预估完成时间等。

**Acceptance Criteria**：
- `ralph_status` 输出包含：
  - 时间线：开始时间、已运行时长、最后更新时间
  - 速度：平均每个 US 耗时、当前 US 已耗时
  - 预估：基于平均速度预估剩余时间（仅供参考）
  - 健康度：停滞次数、重试次数、blocked US 数量
- 格式化输出，使用表格和进度条
- 支持 `--verbose` 参数显示详细的 AC 级别进度

**Priority**: 5

### US-006: Agent 自省日志

**描述**：Agent 在每次 `ralph_update` 时提供自省日志，说明当前策略和下一步计划。

**Acceptance Criteria**：
- `ralph_update` 的 `notes` 字段要求包含结构化的自省信息
- 格式：`{ "implemented": "...", "filesChanged": [...], "learnings": "...", "nextSteps": "...", "confidence": 0.8 }`
- `confidence` 字段（0-1）表示 Agent 对当前实现的信心
- `confidence < 0.5` 连续 2 次 → 建议人工介入
- 自省日志保存到 `ralph-progress.md`（已有机制，增强格式）

**Priority**: 6

### US-007: 手动干预接口

**描述**：提供 `ralph_retry` 工具，允许用户在 Agent blocked 后手动触发重试并注入提示。

**Acceptance Criteria**：
- 新增 `ralph_retry` 工具：`ralph_retry({ branch, hint })`
- `hint` 参数注入到 Agent prompt 中：`"User hint: ${hint}"`
- 重置停滞计数器（但保留历史记录）
- 只能在 `status: blocked` 或 `status: failed` 时使用
- `ralph_retry` 输出包含重试后的状态

**Priority**: 7

## Technical Notes

### 数据库 Schema 变更

```sql
-- 扩展 executions 表
ALTER TABLE executions ADD COLUMN stagnationLog TEXT; -- JSON 格式
ALTER TABLE executions ADD COLUMN startedAt DATETIME;
ALTER TABLE executions ADD COLUMN lastUpdateAt DATETIME;

-- 扩展 user_stories 表
ALTER TABLE user_stories ADD COLUMN blockedReason TEXT; -- JSON 格式
ALTER TABLE user_stories ADD COLUMN confidence REAL; -- 0-1
ALTER TABLE user_stories ADD COLUMN timeSpent INTEGER; -- 秒
```

### 预合并报告模板

```markdown
# Merge Report: ${branch}

## Summary
- **Total US**: ${total} (${completed} completed, ${blocked} blocked)
- **Total AC**: ${totalAC} (${completedAC} completed)
- **Diff**: ${lines} lines, ${files} files
- **Quality**: typecheck ✓, build ✓, tests ${testStatus}

## Completed User Stories

### US-001: ${title}
- **AC Status**: 3/3 completed
- **Evidence**:
  - AC-1: typecheck passed
  - AC-2: build passed
  - AC-3: manual verification
- **Files Changed**: 5 files, 234 lines

## Diff Statistics

| Directory | Files | Lines |
|-----------|-------|-------|
| apps/api/src/modules/auth | 3 | 156 |
| packages/db | 2 | 78 |

## Risk Assessment

${diffLines > 5000 ? '⚠️ **HIGH RISK**: Diff exceeds 5k lines' : '✓ Low risk'}
${files > 50 ? '⚠️ **HIGH RISK**: More than 50 files changed' : '✓ Low risk'}

## Quality Checks

- ✓ Typecheck passed
- ✓ Build passed
- ${testsPassed ? '✓' : '✗'} Tests passed

---
Generated at: ${new Date().toISOString()}
```

### Agent Prompt 增强

```typescript
## Self-Reflection (REQUIRED)

When calling ralph_update, provide structured self-reflection:

{
  "notes": {
    "implemented": "Brief summary of what was done",
    "filesChanged": ["path/to/file1.ts", "path/to/file2.ts"],
    "learnings": "Patterns discovered or gotchas encountered",
    "nextSteps": "What needs to be done next (if not complete)",
    "confidence": 0.8  // 0-1, your confidence in this implementation
  }
}

If confidence < 0.5, explain why and consider marking as blocked.

## Blocking Strategy

If you encounter issues you cannot resolve:
1. Try a different approach (max ${maxRetries} times)
2. If still stuck, mark as blocked with structured reason:
   {
     "passes": false,
     "blockedReason": {
       "type": "environment|dependency|requirement",
       "description": "Clear description of the blocker",
       "suggestedAction": "What needs to happen to unblock"
     }
   }

DO NOT retry infinitely. It's OK to be blocked.
```

## Success Metrics

- Agent 主动标记 blocked 而不是无限重试
- 过大 US 在 `ralph_start` 时被检测并给出拆分建议
- `ralph_merge` 前生成详细报告，包含风险评估
- 停滞检测准确率 > 90%（识别空转重试）
- `ralph_status` 输出包含时间线、速度、健康度
- 用户可以通过 `ralph_retry` 注入提示并重试
