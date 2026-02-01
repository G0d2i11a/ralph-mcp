import { existsSync } from "fs";
import { join } from "path";
import { PresetName } from "./presets/index.js";

// =============================================================================
// TYPES
// =============================================================================

export type ProjectType = "node" | "rust" | "go" | "python" | "unknown";

export interface DetectionResult {
  projectType: ProjectType;
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | "cargo" | "go" | "pip" | null;
  suggestedPreset: PresetName | null;
  confidence: "high" | "medium" | "low";
  indicators: string[];
}

// =============================================================================
// DETECTION LOGIC
// =============================================================================

/**
 * Auto-detect project type and package manager.
 */
export function detectProjectType(projectRoot: string): DetectionResult {
  const indicators: string[] = [];

  // Check for Node.js indicators
  const hasPackageJson = existsSync(join(projectRoot, "package.json"));
  const hasPnpmLock = existsSync(join(projectRoot, "pnpm-lock.yaml"));
  const hasYarnLock = existsSync(join(projectRoot, "yarn.lock"));
  const hasBunLock = existsSync(join(projectRoot, "bun.lockb"));
  const hasPackageLock = existsSync(join(projectRoot, "package-lock.json"));
  const hasNodeModules = existsSync(join(projectRoot, "node_modules"));

  // Check for Rust indicators
  const hasCargoToml = existsSync(join(projectRoot, "Cargo.toml"));
  const hasCargoLock = existsSync(join(projectRoot, "Cargo.lock"));

  // Check for Go indicators
  const hasGoMod = existsSync(join(projectRoot, "go.mod"));
  const hasGoSum = existsSync(join(projectRoot, "go.sum"));

  // Check for Python indicators
  const hasRequirementsTxt = existsSync(join(projectRoot, "requirements.txt"));
  const hasPyprojectToml = existsSync(join(projectRoot, "pyproject.toml"));
  const hasSetupPy = existsSync(join(projectRoot, "setup.py"));
  const hasPipfile = existsSync(join(projectRoot, "Pipfile"));

  // Determine project type and package manager
  // Priority: Rust > Go > Node > Python (based on specificity of indicators)

  // Rust detection
  if (hasCargoToml) {
    indicators.push("Cargo.toml found");
    if (hasCargoLock) {
      indicators.push("Cargo.lock found");
    }
    return {
      projectType: "rust",
      packageManager: "cargo",
      suggestedPreset: "rust",
      confidence: "high",
      indicators,
    };
  }

  // Go detection
  if (hasGoMod) {
    indicators.push("go.mod found");
    if (hasGoSum) {
      indicators.push("go.sum found");
    }
    return {
      projectType: "go",
      packageManager: "go",
      suggestedPreset: "go",
      confidence: "high",
      indicators,
    };
  }

  // Node.js detection
  if (hasPackageJson) {
    indicators.push("package.json found");

    // Determine package manager
    if (hasPnpmLock) {
      indicators.push("pnpm-lock.yaml found");
      return {
        projectType: "node",
        packageManager: "pnpm",
        suggestedPreset: "node-pnpm",
        confidence: "high",
        indicators,
      };
    }

    if (hasYarnLock) {
      indicators.push("yarn.lock found");
      return {
        projectType: "node",
        packageManager: "yarn",
        suggestedPreset: "node-yarn",
        confidence: "high",
        indicators,
      };
    }

    if (hasBunLock) {
      indicators.push("bun.lockb found");
      return {
        projectType: "node",
        packageManager: "bun",
        suggestedPreset: "node-bun",
        confidence: "high",
        indicators,
      };
    }

    if (hasPackageLock) {
      indicators.push("package-lock.json found");
      return {
        projectType: "node",
        packageManager: "npm",
        suggestedPreset: "node-npm",
        confidence: "high",
        indicators,
      };
    }

    // No lock file, default to npm
    if (hasNodeModules) {
      indicators.push("node_modules found (no lock file)");
    }
    return {
      projectType: "node",
      packageManager: "npm",
      suggestedPreset: "node-npm",
      confidence: "medium",
      indicators,
    };
  }

  // Python detection
  if (hasRequirementsTxt || hasPyprojectToml || hasSetupPy || hasPipfile) {
    if (hasRequirementsTxt) indicators.push("requirements.txt found");
    if (hasPyprojectToml) indicators.push("pyproject.toml found");
    if (hasSetupPy) indicators.push("setup.py found");
    if (hasPipfile) indicators.push("Pipfile found");

    return {
      projectType: "python",
      packageManager: "pip",
      suggestedPreset: "python",
      confidence: hasPyprojectToml || hasRequirementsTxt ? "high" : "medium",
      indicators,
    };
  }

  // Unknown project type
  return {
    projectType: "unknown",
    packageManager: null,
    suggestedPreset: null,
    confidence: "low",
    indicators: ["No recognized project files found"],
  };
}

/**
 * Get the install command for a detected package manager.
 */
export function getInstallCommandForDetection(
  detection: DetectionResult
): { command: string; args: string[]; fallbackArgs: string[] } | null {
  switch (detection.packageManager) {
    case "pnpm":
      return {
        command: "pnpm",
        args: ["install", "--frozen-lockfile"],
        fallbackArgs: ["install"],
      };
    case "npm":
      return {
        command: "npm",
        args: ["ci"],
        fallbackArgs: ["install"],
      };
    case "yarn":
      return {
        command: "yarn",
        args: ["install", "--frozen-lockfile"],
        fallbackArgs: ["install"],
      };
    case "bun":
      return {
        command: "bun",
        args: ["install", "--frozen-lockfile"],
        fallbackArgs: ["install"],
      };
    case "cargo":
      return {
        command: "cargo",
        args: ["fetch"],
        fallbackArgs: ["fetch"],
      };
    case "go":
      return {
        command: "go",
        args: ["mod", "download"],
        fallbackArgs: ["mod", "tidy"],
      };
    case "pip":
      return {
        command: "pip",
        args: ["install", "-r", "requirements.txt"],
        fallbackArgs: ["install", "-e", "."],
      };
    default:
      return null;
  }
}
