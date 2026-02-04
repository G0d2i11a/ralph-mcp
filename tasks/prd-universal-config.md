# PRD: Ralph 通用化配置系统

## Description

将 Ralph MCP 从硬编码配置升级为可配置系统，支持不同语言/框架/项目结构，通过 `.ralph.yaml` 配置文件驱动行为。

## Background

当前硬编码问题：
- 质量门禁：`pnpm check-types`, `pnpm --filter api build`
- 主分支：`main`
- 远程仓库：`origin`
- 包管理器：`pnpm install`
- Agent：Claude CLI
- 通知：Windows toast
- 数据目录：`~/.ralph`
- 分支前缀：`ralph/`
- Co-author：固定 Claude

这导致 Ralph 只能用于特定类型的 Node.js 项目，无法跨语言/框架使用。

## Solution

1. 引入 `.ralph.yaml` 项目配置文件
2. 三层配置覆盖：CLI > PRD frontmatter > .ralph.local.yaml > .ralph.yaml > ~/.ralph/config.yaml > 默认值
3. 支持预设（preset）减少配置量
4. 模式别名：explorer = exploration, engineering = delivery
5. exploration 模式默认 autoMerge: false

## User Stories

### US-001: 配置加载器

As a Ralph MCP 用户, I want 系统从配置文件加载设置, So that 可以自定义 Ralph 行为。

**Acceptance Criteria:**
- 创建 `src/config/loader.ts` 实现配置加载
- 支持三层配置文件：
  - `.ralph.yaml`（项目级，提交到 git）
  - `.ralph.local.yaml`（本地级，不提交）
  - `~/.ralph/config.yaml`（全局级）
- 配置合并优先级：CLI > PRD frontmatter > local > project > global > default
- 使用 Zod 校验配置 schema
- 配置文件不存在时使用默认值，不报错

**Priority**: 1

### US-002: 项目配置 Schema

As a Ralph MCP 用户, I want 清晰的配置 schema, So that 知道可以配置什么。

**Acceptance Criteria:**
- 创建 `src/config/schema.ts` 定义配置类型
- 配置结构：
```typescript
interface RalphConfig {
  version: 1;
  extends?: string[];  // preset 或文件路径

  project: {
    mainBranch: string;      // 默认 "main"
    remote: string | null;   // 默认 "origin", null = 本地项目
    branchPrefix: string;    // 默认 "ralph/"
  };

  storage: {
    dataDir: string;         // 默认 "~/.ralph"
  };

  worktree: {
    enabled: boolean;        // 默认 true
    dir: string;             // 默认 ".tmp/worktrees"
  };

  packageManager: {
    type: "auto" | "pnpm" | "npm" | "yarn" | "bun" | "cargo" | "go" | "pip" | "none";
    installCommand?: string; // 自定义安装命令
  };

  gates: Gate[];

  scope: {
    warn: { maxLines: number; maxFiles: number };
    hard: { maxLines: number; maxFiles: number };
    exclude: string[];       // glob 模式
  };

  modes: {
    exploration: ModeConfig;
    delivery: ModeConfig;
    hotfix: ModeConfig;
  };

  agent: {
    launcher: "claude" | "custom";
    command?: string[];
  };

  notifications: {
    enabled: boolean;
    provider: "node-notifier" | "none";
  };

  merge: {
    syncBeforeMerge: boolean;
    push: { enabled: boolean; remote: string; branch: string };
    coAuthor: string;
  };
}
```
- 导出 Zod schema 用于校验

**Priority**: 1

### US-003: 预设系统

As a Ralph MCP 用户, I want 使用预设减少配置量, So that 常见项目类型开箱即用。

**Acceptance Criteria:**
- 创建 `src/config/presets/` 目录
- 内置预设：
  - `node-pnpm`: pnpm + check-types + build
  - `node-npm`: npm + check-types + build
  - `node-yarn`: yarn + check-types + build
  - `rust`: cargo check + clippy + test
  - `go`: go build + go vet + go test
  - `python`: mypy + pytest
- 预设通过 `extends: ["preset:node-pnpm"]` 使用
- 支持组合多个预设：`extends: ["preset:node-pnpm", "./custom.yaml"]`
- 后面的配置覆盖前面的

**Priority**: 2

### US-004: 质量门禁配置化

As a Ralph MCP 用户, I want 自定义质量门禁, So that 可以用于任何语言/框架。

**Acceptance Criteria:**
- Gate 结构：
```typescript
interface Gate {
  id: string;           // 唯一标识
  name: string;         // 显示名称
  command: string | string[];  // 命令（字符串或数组）
  cwd?: string;         // 工作目录，默认 repo root
  timeoutMs?: number;   // 超时，默认 120000
  required: boolean;    // 是否必须通过
  when: ("merge" | "update")[];  // 何时执行
}
```
- 修改 `src/utils/merge-helpers.ts` 从配置读取 gates
- 按 `when` 字段决定何时执行
- 支持 `{repoRoot}`, `{worktreePath}` 变量替换
- 命令数组形式避免 shell 转义问题

**Priority**: 2

### US-005: 项目/分支配置化

As a Ralph MCP 用户, I want 配置主分支和远程仓库, So that 可以用于不同 git 工作流。

**Acceptance Criteria:**
- 修改 `src/utils/worktree.ts` 从配置读取 `mainBranch`
- 修改 `src/tools/merge.ts` 从配置读取 `remote`
- `remote: null` 时跳过 `git fetch` 和 `git push`
- 修改 `src/utils/prd-parser.ts` 从配置读取 `branchPrefix`
- 修改 `src/utils/merge-helpers.ts` 从配置读取 `coAuthor`

**Priority**: 3

### US-006: 模式别名与默认行为

As a Ralph MCP 用户, I want 使用简单的模式名称, So that 更容易理解和使用。

**Acceptance Criteria:**
- CLI 支持别名：
  - `--mode explorer` → `exploration`
  - `--mode engineering` → `delivery`
- PRD frontmatter 也支持别名
- exploration 模式默认 `autoMerge: false`
- 文档中使用"Explorer/Engineering"二分法解释
- 内部仍使用 `exploration/delivery/hotfix` 三值

**Priority**: 3

### US-007: 自动检测项目类型

As a Ralph MCP 用户, I want 系统自动检测项目类型, So that 无需手动配置常见项目。

**Acceptance Criteria:**
- 创建 `src/config/detect.ts` 实现自动检测
- 检测逻辑：
  - `pnpm-lock.yaml` → node-pnpm
  - `yarn.lock` → node-yarn
  - `package-lock.json` → node-npm
  - `bun.lockb` → node-bun
  - `Cargo.toml` → rust
  - `go.mod` → go
  - `pyproject.toml` 或 `requirements.txt` → python
- 检测结果作为 fallback，显式配置优先
- `packageManager.type: "auto"` 时启用自动检测

**Priority**: 4

## Technical Notes

### 配置文件示例

```yaml
# .ralph.yaml
version: 1

extends:
  - preset:node-pnpm

project:
  mainBranch: main
  remote: origin
  branchPrefix: ralph/

gates:
  - id: typecheck
    name: Typecheck
    command: ["pnpm", "check-types"]
    required: true
    when: ["merge"]

  - id: build
    name: Build
    command: ["pnpm", "build"]
    required: true
    when: ["merge"]

  - id: test
    name: Test
    command: ["pnpm", "test"]
    required: false
    when: ["merge"]

scope:
  warn:
    maxLines: 1500
    maxFiles: 15
  hard:
    maxLines: 3000
    maxFiles: 25
  exclude:
    - "**/pnpm-lock.yaml"
    - "**/dist/**"
```

### 本地项目配置

```yaml
# .ralph.yaml (无 remote)
version: 1

project:
  mainBranch: main
  remote: ~  # null = 本地项目，跳过 fetch/push

gates:
  - id: build
    name: Build
    command: cargo build
    required: true
    when: ["merge"]
```

### 迁移策略

1. 所有硬编码值改为从配置读取
2. 无配置文件时使用当前默认值（向后兼容）
3. 逐步迁移，每个 US 独立可测试

## Out of Scope

- Monorepo targets（后续 PRD）
- Web UI 配置编辑器
- 配置文件生成向导
