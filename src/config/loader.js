"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
exports.getConfig = getConfig;
exports.getGlobalConfigDir = getGlobalConfigDir;
exports.getGlobalConfigPath = getGlobalConfigPath;
exports.getProjectConfigPath = getProjectConfigPath;
exports.getLocalConfigPath = getLocalConfigPath;
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = require("path");
const yaml_1 = require("yaml");
const schema_js_1 = require("./schema.js");
const index_js_1 = require("./presets/index.js");
// =============================================================================
// CONFIG LOADING
// =============================================================================
/**
 * Load configuration with three-layer priority:
 * CLI > PRD frontmatter > local > project > global > default
 */
function loadConfig(projectRoot, overrides, prdFrontmatter) {
    const sources = [];
    const errors = [];
    // Layer 1: Global config (~/.ralph/config.yaml)
    const globalPath = (0, path_1.join)((0, os_1.homedir)(), ".ralph", schema_js_1.CONFIG_FILE_NAMES.global);
    const globalSource = loadConfigFile(globalPath);
    sources.push(globalSource);
    if (globalSource.exists && !globalSource.config) {
        errors.push(`Failed to parse global config: ${globalPath}`);
    }
    // Layer 2: Project config (.ralph.yaml)
    const projectPath = (0, path_1.join)(projectRoot, schema_js_1.CONFIG_FILE_NAMES.project);
    const projectSource = loadConfigFile(projectPath);
    sources.push(projectSource);
    if (projectSource.exists && !projectSource.config) {
        errors.push(`Failed to parse project config: ${projectPath}`);
    }
    // Layer 3: Local config (.ralph.local.yaml)
    const localPath = (0, path_1.join)(projectRoot, schema_js_1.CONFIG_FILE_NAMES.local);
    const localSource = loadConfigFile(localPath);
    sources.push(localSource);
    if (localSource.exists && !localSource.config) {
        errors.push(`Failed to parse local config: ${localPath}`);
    }
    // Merge configs in priority order (later overrides earlier)
    let mergedConfig = {};
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
    const parseResult = schema_js_1.RalphConfigSchema.safeParse(mergedConfig);
    if (!parseResult.success) {
        errors.push(`Config validation failed: ${parseResult.error.message}`);
        return {
            config: schema_js_1.DEFAULT_CONFIG,
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
function loadConfigFile(filePath) {
    if (!(0, fs_1.existsSync)(filePath)) {
        return {
            path: filePath,
            exists: false,
            config: null,
        };
    }
    try {
        const content = (0, fs_1.readFileSync)(filePath, "utf-8");
        const parsed = (0, yaml_1.parse)(content);
        return {
            path: filePath,
            exists: true,
            config: parsed || {},
        };
    }
    catch (error) {
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
function applyPresets(config, errors) {
    if (!config.extends || config.extends.length === 0) {
        return config;
    }
    let result = {};
    for (const presetName of config.extends) {
        // Handle preset: prefix
        const normalizedName = presetName.replace(/^preset:/, "");
        if (!(0, index_js_1.isPresetName)(normalizedName)) {
            errors.push(`Unknown preset: ${presetName}`);
            continue;
        }
        const preset = (0, index_js_1.getPreset)(normalizedName);
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
function applyOverrides(config, overrides) {
    const result = { ...config };
    if (overrides.autoMerge !== undefined) {
        result.merge = {
            ...(result.merge || {}),
            autoMerge: overrides.autoMerge,
        };
    }
    if (overrides.notifyOnComplete !== undefined) {
        result.notifications = {
            ...(result.notifications || {}),
            onComplete: overrides.notifyOnComplete,
        };
    }
    if (overrides.onConflict !== undefined) {
        result.merge = {
            ...(result.merge || {}),
            onConflict: overrides.onConflict,
        };
    }
    if (overrides.worktree !== undefined) {
        result.worktree = {
            ...(result.worktree || {}),
            enabled: overrides.worktree,
        };
    }
    if (overrides.mode !== undefined) {
        // Resolve mode alias
        const modes = result.modes || {};
        const aliases = modes.aliases || {};
        const resolvedMode = aliases[overrides.mode] || overrides.mode;
        if (resolvedMode === "exploration" || resolvedMode === "delivery") {
            result.modes = {
                ...modes,
                default: resolvedMode,
            };
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
function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        const sourceValue = source[key];
        const targetValue = result[key];
        if (sourceValue === undefined) {
            continue;
        }
        if (sourceValue === null) {
            result[key] = null;
            continue;
        }
        if (Array.isArray(sourceValue)) {
            // Arrays are replaced, not merged
            result[key] = [...sourceValue];
        }
        else if (typeof sourceValue === "object" &&
            typeof targetValue === "object" &&
            targetValue !== null &&
            !Array.isArray(targetValue)) {
            // Recursively merge objects
            result[key] = deepMerge(targetValue, sourceValue);
        }
        else {
            result[key] = sourceValue;
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
function getConfig(projectRoot, overrides, prdFrontmatter) {
    const { config } = loadConfig(projectRoot, overrides, prdFrontmatter);
    return config;
}
/**
 * Get the global config directory path.
 */
function getGlobalConfigDir() {
    return (0, path_1.join)((0, os_1.homedir)(), ".ralph");
}
/**
 * Get the global config file path.
 */
function getGlobalConfigPath() {
    return (0, path_1.join)(getGlobalConfigDir(), schema_js_1.CONFIG_FILE_NAMES.global);
}
/**
 * Get the project config file path.
 */
function getProjectConfigPath(projectRoot) {
    return (0, path_1.join)(projectRoot, schema_js_1.CONFIG_FILE_NAMES.project);
}
/**
 * Get the local config file path.
 */
function getLocalConfigPath(projectRoot) {
    return (0, path_1.join)(projectRoot, schema_js_1.CONFIG_FILE_NAMES.local);
}
