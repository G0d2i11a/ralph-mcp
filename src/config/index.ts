/**
 * Ralph Configuration System
 *
 * This module provides a flexible configuration system for Ralph MCP,
 * supporting multiple project types and customizable quality gates.
 *
 * Configuration is loaded from multiple sources with the following priority:
 * CLI > PRD frontmatter > .ralph.local.yaml > .ralph.yaml > ~/.ralph/config.yaml > defaults
 */

// Schema and types
export {
  RalphConfigSchema,
  type RalphConfig,
  GateSchema,
  type Gate,
  ProjectConfigSchema,
  type ProjectConfig,
  StorageConfigSchema,
  type StorageConfig,
  WorktreeConfigSchema,
  type WorktreeConfig,
  PackageManagerConfigSchema,
  type PackageManagerConfig,
  ScopeConfigSchema,
  type ScopeConfig,
  ModeConfigSchema,
  type ModeConfig,
  AgentConfigSchema,
  type AgentConfig,
  NotificationConfigSchema,
  type NotificationConfig,
  MergeConfigSchema,
  type MergeConfig,
  DEFAULT_CONFIG,
  CONFIG_FILE_NAMES,
} from "./schema.js";

// Loader
export {
  loadConfig,
  getConfig,
  getGlobalConfigDir,
  getGlobalConfigPath,
  getProjectConfigPath,
  getLocalConfigPath,
  type ConfigSource,
  type LoadedConfig,
  type ConfigOverrides,
} from "./loader.js";

// Presets
export {
  getPreset,
  getPresetNames,
  getPresetDescription,
  isPresetName,
  type PresetName,
  type Preset,
} from "./presets/index.js";

// Detection
export {
  detectProjectType,
  getInstallCommandForDetection,
  type ProjectType,
  type DetectionResult,
} from "./detect.js";
