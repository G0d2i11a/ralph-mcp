# /doc-sync - 文档同步流程

当 ralph-mcp 代码或功能有变更时，确保相关文档同步更新。

## 需要同步的文件

| 文件 | 内容 | 更新时机 |
|------|------|----------|
| `README.md` | 功能介绍、API 参考、使用示例 | 新增/修改工具、参数变更 |
| `SKILL-EXAMPLE.md` | 用户 skill 模板 | 工作流变更、新增最佳实践 |
| `README.zh-CN.md` | 中文文档 | 与 README.md 同步 |
| GitHub description | 一句话介绍 | 核心卖点变更 |

## 同步检查清单

代码变更后，检查以下内容是否需要更新：

### 1. 新增/修改 MCP 工具
- [ ] README.md - Tools 表格
- [ ] README.md - API Reference 示例
- [ ] SKILL-EXAMPLE.md - MCP Tools 表格

### 2. 参数变更
- [ ] README.md - Advanced Options 表格
- [ ] README.md - 示例代码

### 3. 工作流变更
- [ ] README.md - The Ralph Loop 段落
- [ ] README.md - Why Ralph MCP 对比表
- [ ] SKILL-EXAMPLE.md - Core Workflow
- [ ] SKILL-EXAMPLE.md - Typical Session 示例

### 4. 核心卖点变更
- [ ] README.md 开头标语
- [ ] GitHub repo description (`gh api repos/G0d2i11a/ralph-mcp -X PATCH -f description="..."`)

## 同步命令

```bash
# 更新 GitHub description
gh api repos/G0d2i11a/ralph-mcp -X PATCH -f description="新描述"

# 提交文档更新
git add README.md SKILL-EXAMPLE.md README.zh-CN.md
git commit -m "docs: sync documentation with code changes"
git push origin main
```

## 典型流程

```
1. 代码变更完成
2. 运行 /doc-sync 检查
3. 更新相关文档
4. 提交并 push
```

## 示例：添加新功能 "keep chatting"

变更内容：Ralph 支持后台执行，用户可以继续聊天

需要更新：
1. README.md 标语 → 加入 "keep chatting"
2. README.md 对比表 → 新增 "Blocked while waiting → Keep chatting"
3. SKILL-EXAMPLE.md Core Concept → 新增 "Delegate and continue" 段落
4. SKILL-EXAMPLE.md Typical Session → 展示边执行边聊天
5. GitHub description → 加入 "keep chatting"

## 注意事项

- README.zh-CN.md 需要与 README.md 保持同步（中文版）
- SKILL-EXAMPLE.md 是用户复制到自己项目的模板，保持通用性
- 用户项目里的 `.claude/skills/ralph/SKILL.md` 是从 SKILL-EXAMPLE.md 定制的，不需要我们维护
