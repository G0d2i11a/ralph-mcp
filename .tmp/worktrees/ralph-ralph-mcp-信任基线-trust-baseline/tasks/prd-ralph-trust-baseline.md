# Ralph MCP - 信任基线（Trust Baseline）

## Description

建立 Ralph MCP 的信任基线，从"Agent 自判"升级到"程序化验证"，确保每个 User Story 的完成都有可验证的证据。

## User Stories

### US-001: 证据驱动 AC 验证

**描述**：Agent 必须提供结构化证据来证明 AC 完成，而不是简单地声称"完成了"。

**Acceptance Criteria**：
- Agent 在 `ralph_update` 时必须提供结构化证据（命令输出、文件路径、测试结果）
- 硬性要求：typecheck 和 build 必须通过
- 软性要求：每个 AC 需要对应的证据片段
- 证据格式为 JSON：`{ "AC-1": { evidence: "...", command: "...", output: "..." } }`
- 缺少证据的 AC 自动标记为 `passes: false`

**Priority**: 1

### US-002: Per-AC 证据映射

**描述**：每个 AC 都有独立的验证状态，而不是整个 US 的二元状态。

**Acceptance Criteria**：
- 扩展数据库 schema：`user_stories` 表增加 `acStatus` JSON 字段
- 格式：`{ "AC-1": { passes: true, evidence: "..." }, "AC-2": { passes: false, blockedReason: "..." } }`
- `ralph_status` 输出显示每个 AC 的状态（例如："US-001 完成 2/3 AC"）
- `ralph_get` 输出包含每个 AC 的详细状态和证据
- Agent prompt 中明确告知当前哪些 AC 已完成、哪些待完成

**Priority**: 2

### US-003: 范围护栏（程序化 gate）

**描述**：防止 Agent 无意识大范围重构，通过程序化检查限制改动范围。

**Acceptance Criteria**：
- 在 `ralph_update` 后执行 `git diff --numstat` 统计改动
- 排除文件：`pnpm-lock.yaml`、`*.snap`、`*.lock`、生成文件
- Warn 阈值：1500 行或 15 个文件 → 要求 Agent 提供解释
- Hard 阈值：3000 行或 25 个文件 → 拒绝更新并要求拆分
- 解释格式：结构化 JSON `{ "file": "path/to/file.ts", "reason": "为什么在 scope 内", "lines": 123 }`
- 缺少解释或解释不合理时拒绝更新

**Priority**: 3

### US-004: 预先声明 + diff 对账

**描述**：Agent 在开始实现前声明预计会改动的文件，实际 diff 与声明对账。

**Acceptance Criteria**：
- Agent prompt 中要求在开始实现前声明：`{ "expectedFiles": ["path/to/file1.ts", "path/to/file2.ts"] }`
- `ralph_update` 时对比实际改动文件与声明
- 新增文件或新增目录必须在声明中，否则要求解释
- 改动了声明外的文件 → 触发范围护栏检查
- 声明与实际差异过大（>50%）→ 警告并要求重新评估

**Priority**: 4

## Dependencies

无

## Technical Notes

### 数据库 Schema 变更

```sql
-- 扩展 user_stories 表
ALTER TABLE user_stories ADD COLUMN acStatus TEXT; -- JSON 格式
ALTER TABLE user_stories ADD COLUMN evidence TEXT; -- JSON 格式
ALTER TABLE user_stories ADD COLUMN expectedFiles TEXT; -- JSON 格式
```

### Agent Prompt 变更

在 `generateAgentPrompt()` 中增加：

```typescript
## Evidence Requirements (CRITICAL)

When calling ralph_update, you MUST provide structured evidence:

{
  "storyId": "US-001",
  "passes": true,
  "acStatus": {
    "AC-1": {
      "passes": true,
      "evidence": "typecheck passed",
      "command": "pnpm check-types",
      "output": "✓ No type errors"
    },
    "AC-2": { ... }
  },
  "expectedFiles": ["apps/api/src/modules/auth/auth.service.ts"],
  "scopeExplanation": {
    "apps/api/src/modules/auth/auth.service.ts": {
      "reason": "Implementing login logic as per US-001",
      "lines": 45
    }
  }
}

HARD REQUIREMENTS:
- typecheck MUST pass (pnpm check-types)
- build MUST pass (pnpm --filter api build)
- Each AC MUST have evidence
- Diff > 1500 lines or > 15 files MUST have scopeExplanation
- Diff > 3000 lines or > 25 files will be REJECTED
```

### 实施顺序

1. US-001: 修改 `ralph_update` 解析逻辑，要求证据
2. US-002: 数据库 migration + `ralph_status` 输出调整
3. US-003: 实现 diff 统计和阈值检查
4. US-004: 实现预先声明和对账逻辑

## Success Metrics

- Agent 无法通过"我觉得完成了"来标记 AC 为 passes
- `ralph_status` 可以显示"US-001 完成 2/3 AC"
- Agent 改了 50 个文件会被拦截
- 90% 的 US 在第一次提交时就有完整证据
