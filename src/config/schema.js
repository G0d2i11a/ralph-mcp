"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONFIG_FILE_NAMES = exports.DEFAULT_CONFIG = exports.RalphConfigSchema = exports.MergeConfigSchema = exports.NotificationConfigSchema = exports.AgentConfigSchema = exports.ModeConfigSchema = exports.ScopeConfigSchema = exports.PackageManagerConfigSchema = exports.WorktreeConfigSchema = exports.StorageConfigSchema = exports.ProjectConfigSchema = exports.GateSchema = void 0;
const zod_1 = require("zod");
// =============================================================================
// GATE CONFIGURATION
// =============================================================================
/**
 * Quality gate configuration.
 * Gates are commands that must pass before merge.
 */
exports.GateSchema = zod_1.z.object({
    id: zod_1.z.string().describe("Unique identifier for the gate"),
    name: zod_1.z.string().describe("Human-readable name"),
    command: zod_1.z.string().describe("Command to execute"),
    cwd: zod_1.z.string().optional().describe("Working directory (relative to project root)"),
    timeoutMs: zod_1.z.number().default(120000).describe("Timeout in milliseconds"),
    required: zod_1.z.boolean().default(true).describe("Whether this gate must pass"),
    when: zod_1.z
        .enum(["always", "pre-merge", "post-story"])
        .default("pre-merge")
        .describe("When to run this gate"),
});
// =============================================================================
// PROJECT CONFIGURATION
// =============================================================================
exports.ProjectConfigSchema = zod_1.z.object({
    name: zod_1.z.string().optional().describe("Project name (auto-detected from package.json)"),
    type: zod_1.z
        .enum(["node", "rust", "go", "python", "unknown"])
        .optional()
        .describe("Project type (auto-detected if not specified)"),
});
// =============================================================================
// STORAGE CONFIGURATION
// =============================================================================
exports.StorageConfigSchema = zod_1.z.object({
    dataDir: zod_1.z
        .string()
        .default("~/.ralph")
        .describe("Directory for Ralph state and data"),
    maxArchivedExecutions: zod_1.z
        .number()
        .default(50)
        .describe("Maximum number of archived executions to retain"),
});
// =============================================================================
// WORKTREE CONFIGURATION
// =============================================================================
exports.WorktreeConfigSchema = zod_1.z.object({
    enabled: zod_1.z.boolean().default(true).describe("Whether to use git worktrees"),
    baseDir: zod_1.z
        .string()
        .default(".tmp/worktrees")
        .describe("Base directory for worktrees (relative to project root)"),
    prefix: zod_1.z.string().default("ralph-").describe("Prefix for worktree directories"),
});
// =============================================================================
// PACKAGE MANAGER CONFIGURATION
// =============================================================================
exports.PackageManagerConfigSchema = zod_1.z.object({
    type: zod_1.z
        .enum(["pnpm", "npm", "yarn", "bun", "cargo", "go", "pip", "auto"])
        .default("auto")
        .describe("Package manager to use (auto-detected if 'auto')"),
    installCommand: zod_1.z.string().optional().describe("Custom install command"),
    installArgs: zod_1.z.array(zod_1.z.string()).optional().describe("Arguments for install command"),
    fallbackArgs: zod_1.z.array(zod_1.z.string()).optional().describe("Fallback arguments if strict install fails"),
});
// =============================================================================
// SCOPE CONFIGURATION
// =============================================================================
exports.ScopeConfigSchema = zod_1.z.object({
    include: zod_1.z
        .array(zod_1.z.string())
        .optional()
        .describe("Glob patterns for files to include"),
    exclude: zod_1.z
        .array(zod_1.z.string())
        .optional()
        .describe("Glob patterns for files to exclude"),
});
// =============================================================================
// MODE CONFIGURATION
// =============================================================================
exports.ModeConfigSchema = zod_1.z.object({
    default: zod_1.z
        .enum(["exploration", "delivery"])
        .default("delivery")
        .describe("Default execution mode"),
    exploration: zod_1.z
        .object({
        autoMerge: zod_1.z.boolean().default(false).describe("Auto-merge in exploration mode"),
        notifyOnComplete: zod_1.z.boolean().default(true).describe("Notify on completion"),
    })
        .default({}),
    delivery: zod_1.z
        .object({
        autoMerge: zod_1.z.boolean().default(true).describe("Auto-merge in delivery mode"),
        notifyOnComplete: zod_1.z.boolean().default(true).describe("Notify on completion"),
    })
        .default({}),
    aliases: zod_1.z
        .record(zod_1.z.string(), zod_1.z.enum(["exploration", "delivery"]))
        .default({
        explorer: "exploration",
        engineering: "delivery",
    })
        .describe("Mode aliases"),
});
// =============================================================================
// AGENT CONFIGURATION
// =============================================================================
exports.AgentConfigSchema = zod_1.z.object({
    coAuthor: zod_1.z
        .string()
        .default("Claude Opus 4.5 <noreply@anthropic.com>")
        .describe("Co-author for commits"),
    contextInjectionPath: zod_1.z
        .string()
        .optional()
        .describe("Path to context file to inject into agent prompt"),
    stagnation: zod_1.z
        .object({
        noProgressThreshold: zod_1.z
            .number()
            .default(3)
            .describe("Loops with no file changes before stagnation"),
        sameErrorThreshold: zod_1.z
            .number()
            .default(5)
            .describe("Repeated errors before stagnation"),
        maxLoopsPerStory: zod_1.z
            .number()
            .default(10)
            .describe("Maximum loops per story"),
    })
        .default({}),
});
// =============================================================================
// NOTIFICATION CONFIGURATION
// =============================================================================
exports.NotificationConfigSchema = zod_1.z.object({
    enabled: zod_1.z.boolean().default(true).describe("Enable notifications"),
    onComplete: zod_1.z.boolean().default(true).describe("Notify when PRD completes"),
    onFail: zod_1.z.boolean().default(true).describe("Notify when PRD fails"),
    onMerge: zod_1.z.boolean().default(true).describe("Notify when merge completes"),
});
// =============================================================================
// MERGE CONFIGURATION
// =============================================================================
exports.MergeConfigSchema = zod_1.z.object({
    mainBranch: zod_1.z.string().default("main").describe("Main branch name"),
    remote: zod_1.z
        .string()
        .nullable()
        .default("origin")
        .describe("Remote name (null to skip fetch/push)"),
    branchPrefix: zod_1.z.string().default("ralph/").describe("Prefix for feature branches"),
    onConflict: zod_1.z
        .enum(["auto_theirs", "auto_ours", "notify", "agent"])
        .default("agent")
        .describe("Default conflict resolution strategy"),
    autoMerge: zod_1.z.boolean().default(true).describe("Auto-merge when all stories pass"),
    updateDocs: zod_1.z
        .object({
        todo: zod_1.z.boolean().default(true).describe("Update TODO.md on merge"),
        projectStatus: zod_1.z.boolean().default(true).describe("Update PROJECT-STATUS.md on merge"),
        prdIndex: zod_1.z.boolean().default(true).describe("Update tasks/INDEX.md on merge"),
    })
        .default({}),
});
// =============================================================================
// FULL CONFIGURATION
// =============================================================================
exports.RalphConfigSchema = zod_1.z.object({
    // Preset extension
    extends: zod_1.z
        .array(zod_1.z.string())
        .optional()
        .describe("Presets to extend (e.g., ['preset:node-pnpm'])"),
    // Configuration sections
    project: exports.ProjectConfigSchema.default({}),
    storage: exports.StorageConfigSchema.default({}),
    worktree: exports.WorktreeConfigSchema.default({}),
    packageManager: exports.PackageManagerConfigSchema.default({}),
    gates: zod_1.z.array(exports.GateSchema).default([]).describe("Quality gates to run before merge"),
    scope: exports.ScopeConfigSchema.default({}),
    modes: exports.ModeConfigSchema.default({}),
    agent: exports.AgentConfigSchema.default({}),
    notifications: exports.NotificationConfigSchema.default({}),
    merge: exports.MergeConfigSchema.default({}),
});
// =============================================================================
// DEFAULT CONFIGURATION
// =============================================================================
exports.DEFAULT_CONFIG = exports.RalphConfigSchema.parse({});
// =============================================================================
// CONFIG FILE NAMES
// =============================================================================
exports.CONFIG_FILE_NAMES = {
    project: ".ralph.yaml",
    local: ".ralph.local.yaml",
    global: "config.yaml",
};
