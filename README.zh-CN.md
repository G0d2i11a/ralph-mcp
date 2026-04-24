# Ralph MCP

[![npm version](https://badge.fury.io/js/ralph-mcp.svg)](https://www.npmjs.com/package/ralph-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

自主并行执行 PRD 的 MCP 服务器和 Runner，支持 Codex 或 Claude。自动解析 PRD、创建隔离 worktree、追踪进度、合并完成的功能。

基于 [Geoffrey Huntley 的 Ralph 模式](https://ghuntley.com/ralph/)。

配套项目：[Ralph CLI](https://github.com/G0d2i11a/ralph-cli) 提供独立命令行 manager、launchd 重启、lease/revision 恢复和独立 integration worktree。需要 Claude Code/MCP 对话里的 `ralph_start` / `ralph_status` 和 Runner 时，用 Ralph MCP；需要终端优先的常驻管理与 finalize 流程时，用 Ralph CLI。

[English](./README.md)

## 为什么选择 Ralph MCP？

| 没有 Ralph | 有 Ralph |
|------------|----------|
| 一次只能做一个功能 | 多个功能并行执行 |
| 手动管理 git 分支 | 自动 worktree 隔离 |
| 重启后进度丢失 | 状态持久化（JSON） |
| 手动协调合并 | 串行合并队列 |
| 看不到执行进度 | 实时状态追踪 |

## 特性

- **并行执行** - 配合 Claude Code Task 工具同时执行多个 PRD
- **Git Worktree 隔离** - 每个 PRD 在独立 worktree 中运行，零冲突
- **智能合并队列** - 串行合并避免并行合并冲突
- **进度追踪** - 通过 `ralph_status()` 实时查看状态
- **状态持久化** - 重启 Claude Code 不丢失状态（JSON 存储）
- **自动合并** - 一键合并，支持多种冲突解决策略
- **完成通知** - PRD 完成时弹出 Windows Toast 通知

## 安装

### 从 npm 安装

```bash
npm install -g ralph-mcp
```

### 从源码安装

```bash
git clone https://github.com/G0d2i11a/ralph-mcp.git
cd ralph-mcp
npm install
npm run build
```

## 配置

添加到 `~/.claude/mcp.json`：

```json
{
  "mcpServers": {
    "ralph": {
      "command": "npx",
      "args": ["ralph-mcp"]
    }
  }
}
```

或者从源码安装时：

```json
{
  "mcpServers": {
    "ralph": {
      "command": "node",
      "args": ["/path/to/ralph-mcp/dist/index.js"]
    }
  }
}
```

重启 Claude Code 生效。

### Runner 默认后端

- `ralph-runner` 现在将 backend 和 provider 分开解析
- 默认行为是 `agent.backend: cli` + `agent.provider: codex`
- 当 CLI 启动失败时，Runner 会回退到 SDK backend
- 如需强制走 SDK，可设置 `agent.backend: sdk`

### PRD Watch

`ralph-mcp` 自己也有一套 Runner 侧的 PRD 自动摄入 watch，这和 `ralph-cli` 的 watch 是两套独立能力。

- 命令行启用：`ralph-runner --watch-prds --watch-prds-dir ~/prds`
- 或在 `.ralph.yaml` / `~/.ralph/config.yaml` 里配置 `watchers.prdIngestion`
- 首次启动时，当前已存在的匹配文件只会被标记为已见，不会回补执行
- 新出现的 PRD 仍然会先进入 Ralph 正常状态机，再由 Runner 拉起
- 建议同一批任务只选择一个控制面管理：MCP 负责 MCP/Runner 工作流，CLI 负责终端 manager/finalizer 工作流

示例：

```yaml
watchers:
  prdIngestion:
    enabled: true
    watchDir: ~/prds
    filePattern: '^ez4ielts-.*\.json$'
    scanIntervalMs: 15000
    settleMs: 1500
    worktree: true
```

可以将 `examples/ralph.config.example.yaml` 复制为项目内的 `.ralph.yaml`，或者复制到全局 `~/.ralph/config.yaml`：

```yaml
agent:
  backend: cli
  provider: codex
  codex:
    codexPath: codex
    approvalPolicy: never
    sandboxMode: workspace-write
    level: L2

# 如需切换到 Claude CLI：
# agent:
#   backend: cli
#   provider: claude

# 如需强制使用 SDK：
# agent:
#   backend: sdk
#   provider: claude
```

## 工具列表

| 工具 | 说明 |
|------|------|
| `ralph_start` | 启动 PRD 执行（解析 PRD，创建 worktree，交给 Runner 队列） |
| `ralph_status` | 查看所有 PRD 执行状态 |
| `ralph_get` | 获取单个 PRD 详情 |
| `ralph_update` | 更新 User Story 状态（agent 调用） |
| `ralph_stop` | 停止执行 |
| `ralph_merge` | 合并到 main + 清理 worktree |
| `ralph_merge_queue` | 管理串行合并队列 |
| `ralph_set_agent_id` | 记录 agent task ID |

依赖是按仓库隔离的：下游 PRD 只会在同一项目里的上游 PRD 已合并，或上游 PRD 元数据包含 merge 流程写入的 `mergeSha` 后解锁。仅 story 全部完成但尚未合并，不会触发下游执行。

## 使用方法

### 基本流程

```javascript
// 1. 启动 PRD 执行
ralph_start({ prdPath: "tasks/prd-feature.md" })

// 2. 随时查看状态
ralph_status()

// 3. 完成后合并
ralph_merge({ branch: "ralph/prd-feature" })
```

### 配合 Claude Code Task 工具并行执行

Ralph MCP 设计为配合 Claude Code 的 Task 工具实现并行 PRD 执行：

```
1. 分析 PRD，识别可以并行执行的独立任务
2. 通过 ralph_start() 启动多个 PRD
3. 为每个 PRD 启动后台 Task agent
4. 继续聊天 - 规划下一个功能、审查代码等
5. PRD 完成时收到 Windows Toast 通知
6. 通过 ralph_merge() 将完成的 PRD 合并到 main
```

**示例会话：**

```
用户: 并行执行这 3 个 PRD

Claude: 让我分析一下这些 PRD...
        - prd-auth.md（独立）
        - prd-dashboard.md（独立）
        - prd-api.md（独立）

        3 个都可以并行执行。正在启动...

        [为每个 PRD 调用 ralph_start()]
        [启动 3 个后台 Task agent]

        PRD 正在后台运行。你可以继续其他工作。
        完成后我会通知你。

用户: 好的，等待的时候我们来规划下一个功能...

[稍后 - Windows Toast 通知弹出]

Claude: 3 个 PRD 全部完成！
        - ralph/prd-auth: 4/4 US ✓
        - ralph/prd-dashboard: 3/3 US ✓
        - ralph/prd-api: 5/5 US ✓

        准备合并吗？

用户: 是的，全部合并

Claude: [为每个分支调用 ralph_merge()]
        所有 PRD 已成功合并到 main。
```

### API 参考

```javascript
// 启动 PRD 执行（返回 agent prompt）
ralph_start({ prdPath: "tasks/prd-feature.md" })

// 查看所有 PRD 状态
ralph_status()

// 获取单个 PRD 详情
ralph_get({ branch: "ralph/prd-feature" })

// 更新 User Story 状态（agent 调用）
ralph_update({ branch: "ralph/prd-feature", storyId: "US-1", passes: true, notes: "..." })

// 停止执行
ralph_stop({ branch: "ralph/prd-feature" })

// 合并到 main
ralph_merge({ branch: "ralph/prd-feature" })

// 记录 agent ID（用于追踪）
ralph_set_agent_id({ branch: "ralph/prd-feature", agentTaskId: "abc123" })
```

## PRD 格式

Ralph 支持 markdown 和 JSON PRD。PRD watcher 默认监听 `ez4ielts-*.json` 这类 JSON 文件；JSON 里可以写 `repository`，让 watcher 自动推断 `projectRoot`。

Markdown 示例：

```markdown
---
title: 用户认证
priority: high
---

# 用户认证

实现用户登录和注册功能。

## User Stories

### US-1: 用户注册

用户可以创建新账户。

**Acceptance Criteria:**
- [ ] 邮箱验证
- [ ] 密码强度检查
- [ ] 发送确认邮件

### US-2: 用户登录

用户可以登录账户。

**Acceptance Criteria:**
- [ ] 邮箱/密码认证
- [ ] 记住我选项
- [ ] 忘记密码流程
```

JSON 示例：

```json
{
  "repository": "~/Project/my-app",
  "branchName": "ralph/prd-feature",
  "description": "实现功能",
  "dependencies": ["ralph/prd-base"],
  "userStories": [
    {
      "id": "US-001",
      "title": "功能",
      "description": "As a user, I want the feature, so that I can work faster.",
      "acceptanceCriteria": ["端到端可用"],
      "priority": 1
    }
  ]
}
```

## 冲突解决

`ralph_merge` 支持以下策略：

| 策略 | 行为 |
|------|------|
| `auto_theirs` | `git merge -X theirs`，优先 main |
| `auto_ours` | `git merge -X ours`，优先 branch |
| `notify` | 暂停，通知用户手动处理 |
| `agent` | 启动 merge subagent 解决冲突（默认） |

## 数据存储

- 状态文件：`~/.ralph/state.json`
- 日志目录：`~/.ralph/logs/`

可通过 `RALPH_DATA_DIR` 环境变量覆盖数据目录。

## 高级选项

### ralph_start 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `prdPath` | 必填 | PRD markdown 或 JSON 文件路径 |
| `projectRoot` | 当前目录 | 项目根目录 |
| `worktree` | `true` | 创建隔离的 git worktree |
| `autoStart` | `true` | Runner 默认模式下不返回 agent prompt；仅 `RALPH_AUTO_RUNNER=false` 时用于手动 prompt |
| `autoMerge` | `false` | 所有 story 通过后自动合并 |
| `notifyOnComplete` | `true` | 完成时显示 Windows 通知 |
| `onConflict` | `"agent"` | 冲突解决策略：`auto_theirs`, `auto_ours`, `notify`, `agent` |

### 带参数示例

```javascript
ralph_start({
  prdPath: "tasks/prd-feature.md",
  autoMerge: true,           // 完成后自动合并
  notifyOnComplete: true,    // Windows Toast 通知
  onConflict: "auto_theirs"  // 冲突时优先 main
})
```

## 致谢

- [Geoffrey Huntley](https://ghuntley.com/) - 原始 Ralph 模式
- [Anthropic](https://anthropic.com/) - Claude Code 和 MCP 协议

## 许可证

MIT
