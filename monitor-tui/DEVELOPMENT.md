# Ralph Monitor TUI - Development Guide

## 版本区分

### 开发版 (Development)
用于本地开发和调试，支持热重载。

```bash
cd d:/Code/mcp/ralph-mcp/monitor-tui
npm run dev
```

**特点：**
- 使用 `tsx` 直接运行 TypeScript
- 修改代码后重启即可看到效果
- 不需要编译步骤

### Release 版本

#### 方式 1：本地全局安装（推荐）
适合日常使用，安装后可以在任何目录运行。

```bash
cd d:/Code/mcp/ralph-mcp/monitor-tui
npm run build
npm link

# 之后在任何地方运行
ralph-monitor
```

**特点：**
- 编译后的 JavaScript，启动更快
- 全局命令，随时可用
- 更新代码后需要重新 `npm run build && npm link`

#### 方式 2：打包分发
适合分享给其他人使用。

```bash
cd d:/Code/mcp/ralph-mcp/monitor-tui
npm run build:prod

# 生成 ralph-monitor-tui-0.1.0.tgz
# 其他人可以安装：
npm install -g ralph-monitor-tui-0.1.0.tgz
```

#### 方式 3：发布到 npm（可选）
```bash
# 首次发布
npm login
npm publish

# 其他人安装
npm install -g ralph-monitor-tui
```

## 推荐工作流

### 开发阶段
```bash
npm run dev  # 快速测试
```

### 日常使用
```bash
npm run build
npm link
ralph-monitor  # 全局命令
```

### 更新代码后
```bash
npm run build  # 重新编译
# npm link 已经链接，无需重复执行
ralph-monitor  # 使用最新版本
```

## 版本管理

当前版本：`0.1.0`

更新版本号：
```bash
npm version patch  # 0.1.0 -> 0.1.1
npm version minor  # 0.1.0 -> 0.2.0
npm version major  # 0.1.0 -> 1.0.0
```
