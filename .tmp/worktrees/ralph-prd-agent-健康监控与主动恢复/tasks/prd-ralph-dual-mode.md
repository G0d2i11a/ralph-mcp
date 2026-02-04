# Ralph MCP - 双模式配置（Dual Mode Configuration）

## Description

支持 Exploration/Delivery/Hotfix 三种执行模式，根据不同场景调整约束强度。Exploration 模式用于探索和 PoC，Delivery 模式用于可合并的交付，Hotfix 模式用于紧急修复。

## Dependencies

- ralph/prd-ralph-trust-baseline（必须先完成信任基线）

## User Stories

### US-001: 模式配置定义

**描述**：定义三种模式的配置参数，包括 diff 阈值、重试次数、证据要求等。

**Acceptance Criteria**：
- 创建 `src/config/modes.ts` 定义模式配置
- 三种模式：`exploration`、`delivery`（默认）、`hotfix`
- 配置参数包括：
  - `diffWarn`/`diffHard`：diff 行数阈值
  - `filesWarn`/`filesHard`：文件数阈值
  - `maxRetries`：最大重试次数
  - `requireHardEvidence`：是否要求硬性证据
  - `allowSoftAC`：是否允许软性 AC
- Delivery 模式配置：`{ diffWarn: 1500, diffHard: 3000, filesWarn: 15, filesHard: 25, maxRetries: 3, requireHardEvidence: true, allowSoftAC: false }`
- Exploration 模式配置：`{ diffWarn: 3000, diffHard: 8000, filesWarn: 25, filesHard: 60, maxRetries: 7, requireHardEvidence: false, allowSoftAC: true }`
- Hotfix 模式配置：`{ diffWarn: 300, diffHard: 800, filesWarn: 8, filesHard: 15, maxRetries: 2, requireHardEvidence: true, allowSoftAC: false }`

**Priority**: 1

### US-002: PRD frontmatter 支持模式指定

**描述**：PRD 文件可以通过 frontmatter 指定执行模式。

**Acceptance Criteria**：
- PRD 解析器支持读取 frontmatter 中的 `mode` 字段
- 默认值为 `delivery`
- 示例：`---\nmode: exploration\n---`
- 模式值必须是 `exploration`、`delivery`、`hotfix` 之一，否则报错
- `ralph_start` 时读取并存储到 execution 记录中

**Priority**: 2

### US-003: 模式感知的范围护栏

**描述**：范围护栏根据当前模式使用不同的阈值。

**Acceptance Criteria**：
- 修改范围护栏逻辑，从 execution 记录读取模式配置
- 使用对应模式的 `diffWarn`/`diffHard`/`filesWarn`/`filesHard` 阈值
- 警告和拒绝消息中明确显示当前模式和阈值
- 例如："[Delivery Mode] Diff exceeds warn threshold (1500 lines)"

**Priority**: 3

### US-004: 模式感知的证据要求

**描述**：Exploration 模式允许软性 AC，Delivery 模式要求硬性证据。

**Acceptance Criteria**：
- Exploration 模式允许 AC 标注为 `untested` 或 `partial`
- `untested`/`partial` AC 必须包含 `blockedReason` 和 `nextSteps` 字段
- Delivery 模式不允许 `untested`/`partial` AC
- Agent prompt 根据模式调整证据要求说明
- Exploration 模式完成后生成"升级到 Delivery 的 checklist"（列出所有 `untested`/`partial` AC）

**Priority**: 4

### US-005: 模式感知的重试策略

**描述**：不同模式使用不同的重试次数和反摆烂规则。

**Acceptance Criteria**：
- 从模式配置读取 `maxRetries`
- Exploration 模式：每次重试必须引入新信息（新日志/新假设/新测试），否则提前止损
- 检测"空转重试"：连续 2 次重试的 `notes` 字段相似度 >80% → 标记为摆烂
- 摆烂检测后自动标记为 blocked 并停止重试

**Priority**: 5

### US-006: ralph_status 显示模式

**描述**：`ralph_status` 输出中明确显示当前执行的模式。

**Acceptance Criteria**：
- `ralph_status` 输出包含 `mode` 字段
- 格式：`Mode: exploration (允许软性 AC，阈值: 3k/8k 行)`
- `ralph_get` 详细输出也包含模式信息
- Exploration 模式的执行在输出中用 `[EXPLORATION]` 标记

**Priority**: 6

### US-007: Exploration 升级 checklist

**描述**：Exploration 模式完成后，自动生成升级到 Delivery 的 checklist。

**Acceptance Criteria**：
- Exploration 模式的 execution 完成后，生成 `<branch>-upgrade-checklist.md`
- Checklist 包含：
  - 所有 `untested`/`partial` AC 列表
  - 每个 AC 的 `blockedReason` 和 `nextSteps`
  - 预估升级工作量（基于 AC 数量）
- Checklist 保存到 worktree 根目录
- `ralph_status` 输出中提示 checklist 位置

**Priority**: 7

## Technical Notes

### 数据库 Schema 变更

```sql
-- 扩展 executions 表
ALTER TABLE executions ADD COLUMN mode TEXT DEFAULT 'delivery';
```

### 模式配置文件

```typescript
// src/config/modes.ts
export interface ModeConfig {
  diffWarn: number;
  diffHard: number;
  filesWarn: number;
  filesHard: number;
  maxRetries: number;
  requireHardEvidence: boolean;
  allowSoftAC: boolean;
}

export const MODE_CONFIGS: Record<string, ModeConfig> = {
  delivery: {
    diffWarn: 1500,
    diffHard: 3000,
    filesWarn: 15,
    filesHard: 25,
    maxRetries: 3,
    requireHardEvidence: true,
    allowSoftAC: false,
  },
  exploration: {
    diffWarn: 3000,
    diffHard: 8000,
    filesWarn: 25,
    filesHard: 60,
    maxRetries: 7,
    requireHardEvidence: false,
    allowSoftAC: true,
  },
  hotfix: {
    diffWarn: 300,
    diffHard: 800,
    filesWarn: 8,
    filesHard: 15,
    maxRetries: 2,
    requireHardEvidence: true,
    allowSoftAC: false,
  },
};
```

### Agent Prompt 变更

```typescript
## Execution Mode: ${mode.toUpperCase()}

${mode === 'exploration' ? `
**Exploration Mode**: You are in exploration mode. This allows:
- Soft AC (untested/partial) with blockedReason and nextSteps
- Higher retry limit (${config.maxRetries} times)
- Larger diff threshold (${config.diffWarn}/${config.diffHard} lines)

IMPORTANT: Mark AC as "untested" or "partial" if you cannot provide hard evidence yet.
` : mode === 'delivery' ? `
**Delivery Mode**: You are in delivery mode. This requires:
- Hard evidence for ALL AC (no untested/partial allowed)
- Strict diff limits (${config.diffWarn}/${config.diffHard} lines)
- All quality checks must pass

IMPORTANT: This code will be merged to main. Ensure production quality.
` : `
**Hotfix Mode**: You are in hotfix mode. This requires:
- Minimal changes (${config.diffWarn}/${config.diffHard} lines)
- Focused scope (${config.filesWarn}/${config.filesHard} files)
- Fast turnaround (${config.maxRetries} retries max)

IMPORTANT: Only fix the specific issue. No refactoring or improvements.
`}
```

## Success Metrics

- 可以用 `mode: exploration` 跑 PoC，然后切到 `delivery` 补证据
- Exploration 模式的 diff 阈值是 Delivery 的 2 倍
- Hotfix 模式的改动范围是 Delivery 的 1/5
- `ralph_status` 清晰显示当前模式
- Exploration 完成后自动生成升级 checklist
