# PRD: Ralph 执行历史归档与 Merged 状态

## Description

改进 Ralph MCP 的执行记录管理，解决合并后记录丢失、状态语义不清的问题。引入 `merged` 终态和归档机制，保留执行历史供查询。

## Background

当前问题：
1. `ralph_status` 的 `reconcile` 会直接 `deleteExecution()`，合并后记录被清空
2. 没有 `merged` 终态，`completed` 语义不清（是完成实现还是已合并？）
3. `state.json` 没有元信息区分"从未有 PRD"和"全部完成"
4. 没有全局"所有 PRD 已完成"通知

## Solution

1. 新增 `merged` 状态作为成功合并的终态
2. 归档而非删除：合并后移到 `archivedExecutions`
3. `ralph_status` 增强：返回 `overallState` 和 `history`
4. 保留策略：只保留最近 N 条归档（默认 50）

## User Stories

### US-001: 新增 merged 状态

As a Ralph MCP 用户, I want 系统区分"实现完成"和"已合并", So that 可以清楚知道 PRD 的最终状态。

**Acceptance Criteria:**
- `ExecutionStatus` 类型新增 `merged` 状态
- 状态转换规则：`completed → merging → merged`
- `VALID_TRANSITIONS` 更新以支持 `merged`
- `ExecutionRecord` 新增字段：
  - `mergedAt: Date | null`（合并时间）
  - `mergeCommitSha: string | null`（合并 commit SHA）

### US-002: 归档机制

As a Ralph MCP 用户, I want 合并后的记录被归档而非删除, So that 可以查看历史执行记录。

**Acceptance Criteria:**
- `StateRuntime` 新增 `archivedExecutions: ExecutionRecord[]`
- 新增 `archiveExecution(executionId: string)` 函数
- 归档时：
  - 将记录从 `executions` 移到 `archivedExecutions`
  - 同时归档关联的 `userStories`
  - 清理 `mergeQueue` 中的相关记录
- `ralph_merge` 成功后调用 `archiveExecution` 而非 `deleteExecution`

### US-003: 归档保留策略

As a Ralph MCP 用户, I want 系统自动清理旧的归档记录, So that 不会无限增长。

**Acceptance Criteria:**
- 新增配置 `MAX_ARCHIVED_EXECUTIONS`（默认 50）
- 归档时检查数量，超过限制则删除最旧的记录
- 删除时同时清理关联的 `archivedUserStories`
- 可通过环境变量 `RALPH_MAX_ARCHIVED` 配置

### US-004: ralph_status 增强

As a Ralph MCP 用户, I want `ralph_status` 返回更丰富的状态信息, So that 可以了解整体执行情况。

**Acceptance Criteria:**
- 返回值新增 `overallState` 字段：
  - `"never_run"`: 从未有执行记录
  - `"active"`: 有进行中的执行
  - `"all_done"`: 所有执行已完成/合并
- 返回值新增 `history` 字段：最近 N 条归档记录摘要
- 返回值新增 `stats` 字段：
  - `totalExecuted`: 历史执行总数
  - `totalMerged`: 成功合并总数
  - `totalFailed`: 失败总数

### US-005: reconcile 改为归档

As a Ralph MCP 用户, I want `reconcile` 操作归档而非删除记录, So that 不会丢失历史。

**Acceptance Criteria:**
- `reconcile` 检测到已合并的分支时，调用 `archiveExecution`
- `reconcile` 检测到已删除的分支时，标记为 `failed` 并归档
- 归档前记录 `reconcileReason`：
  - `"branch_merged"`: 分支已合并到 main
  - `"branch_deleted"`: 分支被删除
  - `"worktree_missing"`: worktree 不存在

### US-006: 全局完成通知

As a Ralph MCP 用户, I want 所有 PRD 完成时收到通知, So that 知道可以进行下一步工作。

**Acceptance Criteria:**
- `ralph_merge` 成功后检查是否还有活跃执行
- 如果没有活跃执行，返回 `allComplete: true`
- 返回值包含 `completionSummary`：
  - 本次合并的 PRD 信息
  - 总共完成的 PRD 数量
  - 总耗时（从第一个 PRD 开始到最后一个合并）

## Technical Notes

- 归档数据结构与活跃数据相同，便于查询
- 考虑未来可能需要的功能：重新执行归档的 PRD
- `state.json` 版本升级到 v2，兼容 v1 读取

## Out of Scope

- Web UI 查看历史
- 导出历史到外部系统
- 归档数据压缩
