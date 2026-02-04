# PRD: Agent 健康监控与主动恢复

## 背景

当前 Ralph Runner 对 agent 健康状态的检测过于被动：
- 只检测 `starting` 状态的启动超时（60秒）
- 对 `running` 状态的 agent 没有主动检测
- 依赖 `ralph_update` 调用来判断活动，但如果 agent 进程退出或卡住，需要等待很长时间才能发现

**实际遇到的问题：**
1. Agent 进程退出但状态仍为 `running`
2. 网络断开导致 API 调用卡住
3. Claude CLI 会话超时关闭
4. 日志文件停止更新但无人知晓

## 目标

实现主动的 agent 健康监控，快速发现问题并自动恢复。

## 用户故事

### US-001: 日志活动检测

**As a** Ralph 用户
**I want** Runner 主动检测日志文件活动
**So that** 能快速发现 agent 卡住或退出的情况

**Acceptance Criteria:**
- Runner 每次 tick 检查所有 `running` 状态 PRD 的日志文件 mtime
- 日志文件 > 5 分钟无更新 → 标记为 `at_risk`，记录警告
- 日志文件 > 15 分钟无更新 → 标记为 `stale`，触发恢复流程
- 恢复流程：检查进程是否存活，如果不存在则标记为 `failed` 并建议 retry
- 在 `ralph_status` 中显示 `at_risk` 和 `stale` 状态
- 阈值可通过 Runner 配置调整

**Priority:** 1

### US-002: 进程存活检测 (Windows)

**As a** Windows 用户
**I want** Runner 检测 agent 进程是否还在运行
**So that** 能立即发现进程退出的情况

**Acceptance Criteria:**
- 存储 agent 进程的 PID 到 execution 记录
- Runner 每次 tick 检查 `running` 状态 PRD 的进程是否存活
- 使用 `tasklist` 或 Node.js 方式检查 PID
- 进程不存在 → 立即标记为 `failed`，记录 "Agent process exited unexpectedly"
- 支持 Windows 和 Unix 平台

**Priority:** 2

### US-003: 启动确认检测

**As a** Ralph 用户
**I want** 确认 agent 真正开始工作
**So that** 能发现启动后立即退出的情况

**Acceptance Criteria:**
- Agent 启动后，等待日志文件出现第一条 `assistant` 类型消息
- 超过 2 分钟没有 assistant 消息 → 标记为启动失败
- 区分 "启动失败" 和 "运行中卡住" 两种情况
- 启动失败自动重试（使用现有重试机制）

**Priority:** 3

### US-004: 健康状态仪表盘

**As a** Ralph 用户
**I want** 在 TUI 中看到 agent 健康状态
**So that** 能一眼看出哪些 agent 有问题

**Acceptance Criteria:**
- TUI 显示每个 PRD 的健康指标：
  - 日志最后更新时间（相对时间，如 "2m ago"）
  - 活动状态：`active`（<30s）、`idle`（30s-5m）、`at_risk`（5-15m）、`stale`（>15m）
  - 进程状态：`alive` / `dead` / `unknown`
- 使用颜色区分：绿色=健康，黄色=警告，红色=问题
- 在详情面板显示完整健康信息

**Priority:** 4

### US-005: 自动恢复策略

**As a** Ralph 用户
**I want** Runner 自动尝试恢复失败的 agent
**So that** 不需要手动干预

**Acceptance Criteria:**
- 配置 `autoRecover: boolean`（默认 true）
- 当检测到 agent 异常退出时：
  1. 检查 worktree 是否有未提交的更改
  2. 如果有更改，stash 保存
  3. 自动调用 `ralph_retry` 恢复执行
- 最多自动恢复 3 次，超过后需要手动干预
- 记录恢复历史到 execution 的 `recoveryLog` 字段
- `ralph_status` 显示恢复次数和历史

**Priority:** 5

### US-006: 网络/API 健康检测

**As a** Ralph 用户
**I want** 检测网络或 API 问题
**So that** 能区分 agent 问题和基础设施问题

**Acceptance Criteria:**
- Runner 定期（每 5 分钟）执行简单的 API 健康检查
- 如果 API 不可用，暂停启动新 agent，但不标记现有 agent 为失败
- API 恢复后自动继续
- 在 `ralph_status` 中显示 API 健康状态
- 记录 API 不可用的时间段

**Priority:** 6

## 技术设计

### 数据结构扩展

```typescript
interface ExecutionRecord {
  // 现有字段...

  // 新增健康监控字段
  agentPid: number | null;           // Agent 进程 PID
  logPath: string | null;            // 日志文件路径（已有）
  lastLogActivity: Date | null;      // 日志最后更新时间
  healthStatus: 'healthy' | 'at_risk' | 'stale' | 'dead';
  recoveryAttempts: number;          // 自动恢复尝试次数
  recoveryLog: RecoveryEntry[];      // 恢复历史
}

interface RecoveryEntry {
  timestamp: Date;
  reason: string;
  action: 'retry' | 'stash_and_retry' | 'manual_required';
  success: boolean;
}
```

### Runner 配置扩展

```typescript
interface RunnerConfig {
  // 现有配置...

  // 健康检测配置
  healthCheckInterval: number;       // 健康检查间隔（默认 30000ms）
  logIdleThreshold: number;          // 日志空闲警告阈值（默认 300000ms = 5分钟）
  logStaleThreshold: number;         // 日志过期阈值（默认 900000ms = 15分钟）
  autoRecover: boolean;              // 是否自动恢复（默认 true）
  maxRecoveryAttempts: number;       // 最大自动恢复次数（默认 3）
}
```

### 检测流程

```
每次 tick:
  1. recoverTimedOutPrds()     // 现有：检测 starting 超时
  2. checkAgentHealth()        // 新增：检测 running agent 健康
     - 检查日志文件 mtime
     - 检查进程是否存活
     - 更新 healthStatus
     - 触发恢复流程（如果需要）
  3. promotePendingPrds()      // 现有：提升 pending 到 ready
  4. processReadyPrds()        // 现有：启动 ready PRD
```

## 实现优先级

1. **P0 - 必须有**：US-001（日志活动检测）、US-002（进程存活检测）
2. **P1 - 应该有**：US-003（启动确认）、US-005（自动恢复）
3. **P2 - 可以有**：US-004（TUI 健康仪表盘）、US-006（API 健康检测）

## 成功指标

- Agent 异常退出后 < 1 分钟内检测到
- 自动恢复成功率 > 80%
- 减少人工干预次数 > 50%
