import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { parse as parseYaml } from "yaml";
import {
  RalphConfig,
  RalphConfigSchema,
  DEFAULT_CONFIG,
  CONFIG_FILE_NAMES,
} from "./schema.js";
import { getPreset, isPresetName } from "./presets/index.js";

// =============================================================================
// TYPES
// =============================================================================

export interface ConfigSource {
  path: string;
  exists: boolean;
  config: Partial<RalphConfig> | null;
}

export interface LoadedConfig {
  config: RalphConfig;
  sources: ConfigSource[];
  errors: string[];
}

export interface ConfigOverrides {
  // CLI overrides
  autoMerge?: boolean;
  notifyOnComplete?: boolean;
  onConflict?: "auto_theirs" | "auto_ours" | "notify" | "agent";
  worktree?: boolean;
  mode?: string;
}

// =============================================================================
// CONFIG LOADING
// =============================================================================

/**
 * Load configuration with three-layer priority:
 * CLI > PRD frontmatter > local > project > global > default
 */
export function loadConfig(
  projectRoot: string,
  overrides?: ConfigOverrides,
  prdFrontmatter?: Partial<RalphConfig>
): LoadedConfig {
  const sources: ConfigSource[] = [];
  const errors: string[] = [];

  // Layer 1: Global config (~/.ralph/config.yaml)
  const globalPath = join(
    homedir(),
    ".ralph",
    CONFIG_FILE_NAMES.global
  );
  const globalSource = loadConfigFile(globalPath);
  sources.push(globalSource);
  if (globalSource.exists && !globalSource.config) {
    errors.push(`Failed to parse global config: ${globalPath}`);
  }

  // Layer 2: Project config (.ralph.yaml)
  const projectPath = join(projectRoot, CONFIG_FILE_NAMES.project);
  const projectSource = loadConfigFile(projectPath);
  sources.push(projectSource);
  if (projectSource.exists && !projectSource.config) {
    errors.push(`Failed to parse project config: ${projectPath}`);
  }

  // Layer 3: Local config (.ralph.local.yaml)
  const localPath = join(projectRoot, CONFIG_FILE_NAMES.local);
  const localSource = loadConfigFile(localPath);
  sources.push(localSource);
  if (localSource.exists && !localSource.config) {
    errors.push(`Failed to parse local config: ${localPath}`);
  }

  // Merge configs in priority order (later overrides earlier)
  let mergedConfig: Partial<RalphConfig> = {};

  // Start with global
  if (globalSource.config) {
    mergedConfig = deepMerge(mergedConfig, globalSource.config);
  }

  // Apply presets from global config
  if (mergedConfig.extends) {
    mergedConfig = applyPresets(mergedConfig, errors);
  }

  // Apply project config
  if (projectSource.config) {
    mergedConfig = deepMerge(mergedConfig, projectSource.config);
  }

  // Apply presets from project config
  if (projectSource.config?.extends) {
    mergedConfig = applyPresets(mergedConfig, errors);
  }

  // Apply local config
  if (localSource.config) {
    mergedConfig = deepMerge(mergedConfig, localSource.config);
  }

  // Apply presets from local config
  if (localSource.config?.extends) {
    mergedConfig = applyPresets(mergedConfig, errors);
  }

  // Apply PRD frontmatter
  if (prdFrontmatter) {
    mergedConfig = deepMerge(mergedConfig, prdFrontmatter);
  }

  // Apply CLI overrides
  if (overrides) {
    mergedConfig = applyOverrides(mergedConfig, overrides);
  }

  // Validate and fill defaults
  const parseResult = RalphConfigSchema.safeParse(mergedConfig);
  if (!parseResult.success) {
    errors.push(`Config validation failed: ${parseResult.error.message}`);
    return {
      config: DEFAULT_CONFIG,
      sources,
      errors,
    };
  }

  return {
    config: parseResult.data,
    sources,
    errors,
  };
}

/**
 * Load a single config file.
 */
function loadConfigFile(filePath: string): ConfigSource {
  if (!existsSync(filePath)) {
    return {
      path: filePath,
      exists: false,
      config: null,
    };
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = parseYaml(content);
    return {
      path: filePath,
      exists: true,
      config: parsed || {},
    };
  } catch (error) {
    return {
      path: filePath,
      exists: true,
      config: null,
    };
  }
}

/**
 * Apply presets from the extends array.
 */
function applyPresets(
  config: Partial<RalphConfig>,
  errors: string[]
): Partial<RalphConfig> {
  if (!config.extends || config.extends.length === 0) {
    return config;
  }

  let result: Partial<RalphConfig> = {};

  for (const presetName of config.extends) {
    // Handle preset: prefix
    const normalizedName = presetName.replace(/^preset:/, "");

    if (!isPresetName(normalizedName)) {
      errors.push(`Unknown preset: ${presetName}`);
      continue;
    }

    const preset = getPreset(normalizedName);
    if (preset) {
      result = deepMerge(result, preset);
    }
  }

  // Merge the original config on top of presets
  // Remove extends to avoid re-processing
  const { extends: _, ...configWithoutExtends } = config;
  result = deepMerge(result, configWithoutExtends);

  return result;
}

/**
 * Apply CLI overrides to config.
 * Note: This operates on Partial<RalphConfig>, so we use type assertions
 * since the final validation will fill in defaults.
 */
function applyOverrides(
  config: Partial<RalphConfig>,
  overrides: ConfigOverrides
): Partial<RalphConfig> {
  const result = { ...config };

  if (overrides.autoMerge !== undefined) {
    result.merge = {
      ...(result.merge || {}),
      autoMerge: overrides.autoMerge,
    } as RalphConfig["merge"];
  }

  if (overrides.notifyOnComplete !== undefined) {
    result.notifications = {
      ...(result.notifications || {}),
      onComplete: overrides.notifyOnComplete,
    } as RalphConfig["notifications"];
  }

  if (overrides.onConflict !== undefined) {
    result.merge = {
      ...(result.merge || {}),
      onConflict: overrides.onConflict,
    } as RalphConfig["merge"];
  }

  if (overrides.worktree !== undefined) {
    result.worktree = {
      ...(result.worktree || {}),
      enabled: overrides.worktree,
    } as RalphConfig["worktree"];
  }

  if (overrides.mode !== undefined) {
    // Resolve mode alias
    const modes = result.modes || {};
    const aliases = (modes as Partial<RalphConfig["modes"]>).aliases || {};
    const resolvedMode = aliases[overrides.mode] || overrides.mode;

    if (resolvedMode === "exploration" || resolvedMode === "delivery") {
      result.modes = {
        ...(modes as Partial<RalphConfig["modes"]>),
        default: resolvedMode,
      } as RalphConfig["modes"];
    }
  }

  return result;
}

// =============================================================================
// DEEP MERGE UTILITY
// =============================================================================

/**
 * Deep merge two objects.
 * Arrays are replaced, not merged.
 */
function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>
): T {
  const result = { ...target } as T;

  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceValue = source[key];
    const targetValue = result[key];

    if (sourceValue === undefined) {
      continue;
    }

    if (sourceValue === null) {
      result[key] = null as T[keyof T];
      continue;
    }

    if (Array.isArray(sourceValue)) {
      // Arrays are replaced, not merged
      result[key] = [...sourceValue] as T[keyof T];
    } else if (
      typeof sourceValue === "object" &&
      typeof targetValue === "object" &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      // Recursively merge objects
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      ) as T[keyof T];
    } else {
      result[key] = sourceValue as T[keyof T];
    }
  }

  return result;
}

// =============================================================================
// CONVENIENCE FUNCTIONS
// =============================================================================

/**
 * Get the effective config for a project.
 * This is the main entry point for getting configuration.
 */
export function getConfig(
  projectRoot: string,
  overrides?: ConfigOverrides,
  prdFrontmatter?: Partial<RalphConfig>
): RalphConfig {
  const { config } = loadConfig(projectRoot, overrides, prdFrontmatter);
  return config;
}

/**
 * Get the global config directory path.
 */
export function getGlobalConfigDir(): string {
  return join(homedir(), ".ralph");
}

/**
 * Get the global config file path.
 */
export function getGlobalConfigPath(): string {
  return join(getGlobalConfigDir(), CONFIG_FILE_NAMES.global);
}

/**
 * Get the project config file path.
 */
export function getProjectConfigPath(projectRoot: string): string {
  return join(projectRoot, CONFIG_FILE_NAMES.project);
}

/**
 * Get the local config file path.
 */
export function getLocalConfigPath(projectRoot: string): string {
  return join(projectRoot, CONFIG_FILE_NAMES.local);
}
