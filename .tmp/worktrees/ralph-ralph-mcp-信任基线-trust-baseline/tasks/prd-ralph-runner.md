# PRD: Ralph Runner - 自动启动依赖 PRD

## Description

实现 Ralph Runner，一个独立进程，自动监控 PRD 状态并启动依赖满足的 PRD。解决当前需要手动启动依赖 PRD 的问题。

## Background

当前 Ralph MCP 的依赖管理存在一个 gap：
- `ralph_update` 会检测依赖满足的 PRD，生成 `agentPrompt`
- 但 **不会自动启动 Agent**（MCP 架构限制）
- 需要手动用 Claude Code 的 Task 工具启动

## Solution

采用 Codex 推荐的"事件化/队列化"方案：
1. 引入新状态：`pending → ready → starting → running`
2. `ralph_update` 触发：依赖满足时标记为 `ready`
3. Runner 职责：`claim ready → 启动 Agent → 回写 agentTaskId`

## Dependencies

- ralph/ralph-mcp-信任基线-trust-baseline

## User Stories

### US-001: 新增 ready/starting 状态

As a Ralph MCP 用户, I want 系统支持 `ready` 和 `starting` 状态, So that 可以精确跟踪 PRD 的启动流程。

**Acceptance Criteria:**
- `ExecutionStatus` 类型新增 `ready` 和 `starting` 状态
- 状态转换规则：
  - `pending → ready`（依赖满足时）
  - `ready → starting`（Runner 领取时）
  - `starting → running`（Agent 启动成功时）
  - `starting → ready`（启动失败时，允许重试）
- `VALID_TRANSITIONS` 更新以支持新状态
- `ralph_status` 输出包含新状态的统计

### US-002: ralph_update 自动标记 ready

As a Ralph MCP 用户, I want `ralph_update` 在 PRD 完成时自动将依赖的 PRD 标记为 `ready`, So that Runner 可以检测到可启动的 PRD。

**Acceptance Criteria:**
- `ralph_update` 检测到 `allComplete` 时，查找依赖的 PRD
- 对每个依赖满足的 PRD：
  - 执行 `syncMainToBranch` 同步 worktree
  - 同步成功则标记为 `ready`
  - 同步失败则保持 `pending`，记录失败原因
- 返回值包含 `readyDependents` 数组（替代 `triggeredDependents`）

### US-003: 新增 ralph_claim_ready 工具

As a Ralph Runner, I want 一个 `ralph_claim_ready` 工具, So that 可以原子地领取并启动 ready 状态的 PRD。

**Acceptance Criteria:**
- 新增 `ralph_claim_ready` MCP 工具
- 输入参数：`branch`（要领取的 PRD 分支）
- 原子操作：
  - 检查状态是否为 `ready`
  - 原子更新为 `starting`（compare-and-swap）
  - 生成 `agentPrompt`
- 返回值：`{ success, branch, agentPrompt, error? }`
- 如果状态不是 `ready`，返回 `success: false`

### US-004: 实现 Runner 轮询逻辑

As a Ralph MCP 用户, I want 一个独立的 Runner 进程, So that 可以自动启动 ready 状态的 PRD。

**Acceptance Criteria:**
- 创建 `src/runner.ts` 实现 Runner 逻辑
- 轮询间隔可配置（默认 5 秒）
- 轮询逻辑：
  - 调用 `ralph_status({ reconcile: false })` 获取状态
  - 筛选 `status === 'ready'` 的 PRD
  - 对每个 ready PRD 调用 `ralph_claim_ready`
  - 启动 Claude CLI Agent
  - 调用 `ralph_set_agent_id` 回写 agentTaskId
- 支持并发启动多个 PRD（可配置并发数）
- 日志输出启动过程

### US-005: Claude CLI 启动封装

As a Ralph Runner, I want 一个可靠的 Claude CLI 启动封装, So that 可以稳定地启动 Agent。

**Acceptance Criteria:**
- 创建 `src/utils/launcher.ts` 封装启动逻辑
- 支持通过 Claude CLI 启动 Agent：`claude --print --dangerously-skip-permissions`
- 启动参数：
  - `prompt`：agentPrompt
  - `cwd`：worktreePath
- 返回值：`{ success, agentTaskId?, error? }`
- 启动失败时返回详细错误信息

### US-006: 崩溃恢复策略

As a Ralph MCP 用户, I want Runner 支持崩溃恢复, So that 启动失败或 Runner 崩溃后可以自动重试。

**Acceptance Criteria:**
- `ExecutionRecord` 新增字段：
  - `launchAttemptAt: Date | null`（最后一次启动尝试时间）
  - `launchAttempts: number`（启动尝试次数）
- `starting` 状态超时检测（默认 60 秒）：
  - 超时后自动回退到 `ready`
  - 增加 `launchAttempts` 计数
- 最大重试次数可配置（默认 3 次）
- 超过最大重试次数标记为 `failed`，记录原因

### US-007: Runner CLI 入口

As a Ralph MCP 用户, I want 一个 CLI 命令启动 Runner, So that 可以方便地运行 Runner。

**Acceptance Criteria:**
- 在 `package.json` 添加 `bin` 入口：`ralph-runner`
- CLI 参数：
  - `--interval <ms>`：轮询间隔（默认 5000）
  - `--concurrency <n>`：并发启动数（默认 1）
  - `--max-retries <n>`：最大重试次数（默认 3）
  - `--timeout <ms>`：启动超时（默认 60000）
- 支持 `Ctrl+C` 优雅退出
- 启动时输出配置信息

## Technical Notes

- Runner 是独立进程，不是 MCP 服务器的一部分
- Runner 通过直接调用 Ralph MCP 的状态管理函数（不是 MCP 协议）
- 或者 Runner 作为 MCP 客户端调用 Ralph MCP 工具
- 推荐前者，避免 MCP 协议开销

## Out of Scope

- Web UI 监控界面
- 分布式 Runner（多实例协调）
- 自定义 Launcher（非 Claude CLI）
