# Ralph MCP

[![npm version](https://badge.fury.io/js/ralph-mcp.svg)](https://www.npmjs.com/package/ralph-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

用于 Claude Code 自主执行 PRD 的 MCP 服务器。支持 Git worktree 隔离、进度追踪、自动合并。

基于 [Geoffrey Huntley 的 Ralph 模式](https://ghuntley.com/ralph/)。

[English](./README.md)

## 特性

- **PRD 解析** - 从 markdown PRD 文件中提取 User Stories
- **Git Worktree 隔离** - 每个 PRD 在独立的 worktree 中运行
- **进度追踪** - 通过 `ralph_status()` 实时查看状态
- **自动合并** - 一键合并，支持冲突解决策略
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

```javascript
// 启动 PRD 执行
ralph_start({ prdPath: "tasks/prd-feature.md" })

// 查看所有状态
ralph_status()

// 获取单个 PRD 详情
ralph_get({ branch: "ralph/prd-feature" })

// 更新 US 状态（agent 完成后调用）
ralph_update({ branch: "ralph/prd-feature", storyId: "US-1", passes: true, notes: "..." })

// 合并完成的 PRD
ralph_merge({ branch: "ralph/prd-feature" })
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

## 致谢

- [Geoffrey Huntley](https://ghuntley.com/) - 原始 Ralph 模式
- [Anthropic](https://anthropic.com/) - Claude Code 和 MCP 协议

## 许可证

MIT
