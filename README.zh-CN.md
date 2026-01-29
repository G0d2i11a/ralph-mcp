# Ralph MCP

[![npm version](https://badge.fury.io/js/ralph-mcp.svg)](https://www.npmjs.com/package/ralph-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

用于 Claude Code 自主执行 PRD 的 MCP 服务器。支持 Git worktree 隔离、进度追踪、自动合并。

基于 [Geoffrey Huntley 的 Ralph 模式](https://ghuntley.com/ralph/)。

[English](./README.md)

## 特性

- **PRD 解析** - 从 markdown PRD 文件中提取 User Stories
- **Git Worktree 隔离** - 每个 PRD 在独立的 worktree 中运行
- **后台执行** - 配合 Claude Code 的 Task 工具并行执行多个 PRD
- **进度追踪** - 通过 `ralph_status()` 实时查看状态
- **自动合并** - 一键合并，支持冲突解决策略
- **完成通知** - PRD 完成时弹出 Windows Toast 通知
- **状态持久化** - 重启 Claude Code 不丢失状态（JSON 存储）

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

## 工具列表

| 工具 | 说明 |
|------|------|
| `ralph_start` | 启动 PRD 执行（解析 PRD，创建 worktree，返回 agent prompt） |
| `ralph_status` | 查看所有 PRD 执行状态 |
| `ralph_get` | 获取单个 PRD 详情 |
| `ralph_update` | 更新 User Story 状态（agent 调用） |
| `ralph_stop` | 停止执行 |
| `ralph_merge` | 合并到 main + 清理 worktree |
| `ralph_merge_queue` | 管理串行合并队列 |
| `ralph_set_agent_id` | 记录 Task agent ID |

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

// 记录 Task agent ID（用于追踪）
ralph_set_agent_id({ branch: "ralph/prd-feature", agentTaskId: "abc123" })
```

## PRD 格式

Ralph 解析 markdown 格式的 PRD 文件。示例：

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
| `prdPath` | 必填 | PRD markdown 文件路径 |
| `projectRoot` | 当前目录 | 项目根目录 |
| `worktree` | `true` | 创建隔离的 git worktree |
| `autoStart` | `true` | 返回 agent prompt 以便立即执行 |
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
