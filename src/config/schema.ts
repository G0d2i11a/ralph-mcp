import { z } from "zod";

// =============================================================================
// GATE CONFIGURATION
// =============================================================================

/**
 * Quality gate configuration.
 * Gates are commands that must pass before merge.
 */
export const GateSchema = z.object({
  id: z.string().describe("Unique identifier for the gate"),
  name: z.string().describe("Human-readable name"),
  command: z.string().describe("Command to execute"),
  cwd: z.string().optional().describe("Working directory (relative to project root)"),
  timeoutMs: z.number().default(120000).describe("Timeout in milliseconds"),
  required: z.boolean().default(true).describe("Whether this gate must pass"),
  when: z
    .enum(["always", "pre-merge", "post-story"])
    .default("pre-merge")
    .describe("When to run this gate"),
});

export type Gate = z.infer<typeof GateSchema>;

// =============================================================================
// PROJECT CONFIGURATION
// =============================================================================

export const ProjectConfigSchema = z.object({
  name: z.string().optional().describe("Project name (auto-detected from package.json)"),
  type: z
    .enum(["node", "rust", "go", "python", "unknown"])
    .optional()
    .describe("Project type (auto-detected if not specified)"),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

// =============================================================================
// STORAGE CONFIGURATION
// =============================================================================

export const StorageConfigSchema = z.object({
  dataDir: z
    .string()
    .default("~/.ralph")
    .describe("Directory for Ralph state and data"),
  maxArchivedExecutions: z
    .number()
    .default(50)
    .describe("Maximum number of archived executions to retain"),
});

export type StorageConfig = z.infer<typeof StorageConfigSchema>;

// =============================================================================
// WORKTREE CONFIGURATION
// =============================================================================

export const WorktreeConfigSchema = z.object({
  enabled: z.boolean().default(true).describe("Whether to use git worktrees"),
  baseDir: z
    .string()
    .default(".tmp/worktrees")
    .describe("Base directory for worktrees (relative to project root)"),
  prefix: z.string().default("ralph-").describe("Prefix for worktree directories"),
});

export type WorktreeConfig = z.infer<typeof WorktreeConfigSchema>;

// =============================================================================
// PACKAGE MANAGER CONFIGURATION
// =============================================================================

export const PackageManagerConfigSchema = z.object({
  type: z
    .enum(["pnpm", "npm", "yarn", "bun", "cargo", "go", "pip", "auto"])
    .default("auto")
    .describe("Package manager to use (auto-detected if 'auto')"),
  installCommand: z.string().optional().describe("Custom install command"),
  installArgs: z.array(z.string()).optional().describe("Arguments for install command"),
  fallbackArgs: z.array(z.string()).optional().describe("Fallback arguments if strict install fails"),
});

export type PackageManagerConfig = z.infer<typeof PackageManagerConfigSchema>;

// =============================================================================
// SCOPE CONFIGURATION
// =============================================================================

export const ScopeConfigSchema = z.object({
  include: z
    .array(z.string())
    .optional()
    .describe("Glob patterns for files to include"),
  exclude: z
    .array(z.string())
    .optional()
    .describe("Glob patterns for files to exclude"),
});

export type ScopeConfig = z.infer<typeof ScopeConfigSchema>;

// =============================================================================
// MODE CONFIGURATION
// =============================================================================

export const ModeConfigSchema = z.object({
  default: z
    .enum(["exploration", "delivery"])
    .default("delivery")
    .describe("Default execution mode"),
  exploration: z
    .object({
      autoMerge: z.boolean().default(false).describe("Auto-merge in exploration mode"),
      notifyOnComplete: z.boolean().default(true).describe("Notify on completion"),
    })
    .default({}),
  delivery: z
    .object({
      autoMerge: z.boolean().default(true).describe("Auto-merge in delivery mode"),
      notifyOnComplete: z.boolean().default(true).describe("Notify on completion"),
    })
    .default({}),
  aliases: z
    .record(z.string(), z.enum(["exploration", "delivery"]))
    .default({
      explorer: "exploration",
      engineering: "delivery",
    })
    .describe("Mode aliases"),
});

export type ModeConfig = z.infer<typeof ModeConfigSchema>;

// =============================================================================
// AGENT CONFIGURATION
// =============================================================================

export const AgentConfigSchema = z.object({
  coAuthor: z
    .string()
    .default("Claude Opus 4.5 <noreply@anthropic.com>")
    .describe("Co-author for commits"),
  contextInjectionPath: z
    .string()
    .optional()
    .describe("Path to context file to inject into agent prompt"),
  stagnation: z
    .object({
      noProgressThreshold: z
        .number()
        .default(3)
        .describe("Loops with no file changes before stagnation"),
      sameErrorThreshold: z
        .number()
        .default(5)
        .describe("Repeated errors before stagnation"),
      maxLoopsPerStory: z
        .number()
        .default(10)
        .describe("Maximum loops per story"),
    })
    .default({}),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// =============================================================================
// NOTIFICATION CONFIGURATION
// =============================================================================

export const NotificationConfigSchema = z.object({
  enabled: z.boolean().default(true).describe("Enable notifications"),
  onComplete: z.boolean().default(true).describe("Notify when PRD completes"),
  onFail: z.boolean().default(true).describe("Notify when PRD fails"),
  onMerge: z.boolean().default(true).describe("Notify when merge completes"),
});

export type NotificationConfig = z.infer<typeof NotificationConfigSchema>;

// =============================================================================
// MERGE CONFIGURATION
// =============================================================================

export const MergeConfigSchema = z.object({
  mainBranch: z.string().default("main").describe("Main branch name"),
  remote: z
    .string()
    .nullable()
    .default("origin")
    .describe("Remote name (null to skip fetch/push)"),
  branchPrefix: z.string().default("ralph/").describe("Prefix for feature branches"),
  onConflict: z
    .enum(["auto_theirs", "auto_ours", "notify", "agent"])
    .default("agent")
    .describe("Default conflict resolution strategy"),
  autoMerge: z.boolean().default(true).describe("Auto-merge when all stories pass"),
  updateDocs: z
    .object({
      todo: z.boolean().default(true).describe("Update TODO.md on merge"),
      projectStatus: z.boolean().default(true).describe("Update PROJECT-STATUS.md on merge"),
      prdIndex: z.boolean().default(true).describe("Update tasks/INDEX.md on merge"),
    })
    .default({}),
});

export type MergeConfig = z.infer<typeof MergeConfigSchema>;

// =============================================================================
// FULL CONFIGURATION
// =============================================================================

export const RalphConfigSchema = z.object({
  // Preset extension
  extends: z
    .array(z.string())
    .optional()
    .describe("Presets to extend (e.g., ['preset:node-pnpm'])"),

  // Configuration sections
  project: ProjectConfigSchema.default({}),
  storage: StorageConfigSchema.default({}),
  worktree: WorktreeConfigSchema.default({}),
  packageManager: PackageManagerConfigSchema.default({}),
  gates: z.array(GateSchema).default([]).describe("Quality gates to run before merge"),
  scope: ScopeConfigSchema.default({}),
  modes: ModeConfigSchema.default({}),
  agent: AgentConfigSchema.default({}),
  notifications: NotificationConfigSchema.default({}),
  merge: MergeConfigSchema.default({}),
});

export type RalphConfig = z.infer<typeof RalphConfigSchema>;

// =============================================================================
// DEFAULT CONFIGURATION
// =============================================================================

export const DEFAULT_CONFIG: RalphConfig = RalphConfigSchema.parse({});

// =============================================================================
// CONFIG FILE NAMES
// =============================================================================

export const CONFIG_FILE_NAMES = {
  project: ".ralph.yaml",
  local: ".ralph.local.yaml",
  global: "config.yaml",
} as const;
