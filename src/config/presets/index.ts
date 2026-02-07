import { RalphConfig } from "../schema.js";

// =============================================================================
// PRESET TYPES
// =============================================================================

export type PresetName =
  | "node-pnpm"
  | "node-npm"
  | "node-yarn"
  | "node-bun"
  | "rust"
  | "go"
  | "python";

export type Preset = Partial<RalphConfig>;

// =============================================================================
// NODE PRESETS
// =============================================================================

const nodeBasePreset: Preset = {
  project: {
    type: "node",
  },
  gates: [
    {
      id: "type-check",
      name: "Type Check",
      command: "npm run check-types",
      timeoutMs: 120000,
      required: true,
      when: "pre-merge",
    },
    {
      id: "build",
      name: "Build",
      command: "npm run build",
      timeoutMs: 180000,
      required: true,
      when: "pre-merge",
    },
  ],
};

const nodePnpmPreset: Preset = {
  ...nodeBasePreset,
  packageManager: {
    type: "pnpm",
    installArgs: ["install", "--frozen-lockfile"],
    fallbackArgs: ["install"],
  },
  gates: [
    {
      id: "type-check",
      name: "Type Check",
      command: "pnpm check-types",
      timeoutMs: 120000,
      required: true,
      when: "pre-merge",
    },
    {
      id: "build",
      name: "Build",
      command: "pnpm build",
      timeoutMs: 180000,
      required: true,
      when: "pre-merge",
    },
  ],
};

const nodeNpmPreset: Preset = {
  ...nodeBasePreset,
  packageManager: {
    type: "npm",
    installArgs: ["ci"],
    fallbackArgs: ["install"],
  },
};

const nodeYarnPreset: Preset = {
  ...nodeBasePreset,
  packageManager: {
    type: "yarn",
    installArgs: ["install", "--frozen-lockfile"],
    fallbackArgs: ["install"],
  },
  gates: [
    {
      id: "type-check",
      name: "Type Check",
      command: "yarn check-types",
      timeoutMs: 120000,
      required: true,
      when: "pre-merge",
    },
    {
      id: "build",
      name: "Build",
      command: "yarn build",
      timeoutMs: 180000,
      required: true,
      when: "pre-merge",
    },
  ],
};

const nodeBunPreset: Preset = {
  ...nodeBasePreset,
  packageManager: {
    type: "bun",
    installArgs: ["install", "--frozen-lockfile"],
    fallbackArgs: ["install"],
  },
  gates: [
    {
      id: "type-check",
      name: "Type Check",
      command: "bun run check-types",
      timeoutMs: 120000,
      required: true,
      when: "pre-merge",
    },
    {
      id: "build",
      name: "Build",
      command: "bun run build",
      timeoutMs: 180000,
      required: true,
      when: "pre-merge",
    },
  ],
};

// =============================================================================
// RUST PRESET
// =============================================================================

const rustPreset: Preset = {
  project: {
    type: "rust",
  },
  packageManager: {
    type: "cargo",
    installCommand: "cargo",
    installArgs: ["fetch"],
    fallbackArgs: ["fetch"],
  },
  gates: [
    {
      id: "check",
      name: "Cargo Check",
      command: "cargo check",
      timeoutMs: 300000,
      required: true,
      when: "pre-merge",
    },
    {
      id: "clippy",
      name: "Clippy Lint",
      command: "cargo clippy -- -D warnings",
      timeoutMs: 300000,
      required: true,
      when: "pre-merge",
    },
    {
      id: "test",
      name: "Cargo Test",
      command: "cargo test",
      timeoutMs: 600000,
      required: true,
      when: "pre-merge",
    },
    {
      id: "build",
      name: "Cargo Build",
      command: "cargo build --release",
      timeoutMs: 600000,
      required: true,
      when: "pre-merge",
    },
  ],
};

// =============================================================================
// GO PRESET
// =============================================================================

const goPreset: Preset = {
  project: {
    type: "go",
  },
  packageManager: {
    type: "go",
    installCommand: "go",
    installArgs: ["mod", "download"],
    fallbackArgs: ["mod", "tidy"],
  },
  gates: [
    {
      id: "vet",
      name: "Go Vet",
      command: "go vet ./...",
      timeoutMs: 120000,
      required: true,
      when: "pre-merge",
    },
    {
      id: "test",
      name: "Go Test",
      command: "go test ./...",
      timeoutMs: 300000,
      required: true,
      when: "pre-merge",
    },
    {
      id: "build",
      name: "Go Build",
      command: "go build ./...",
      timeoutMs: 300000,
      required: true,
      when: "pre-merge",
    },
  ],
};

// =============================================================================
// PYTHON PRESET
// =============================================================================

const pythonPreset: Preset = {
  project: {
    type: "python",
  },
  packageManager: {
    type: "pip",
    installCommand: "pip",
    installArgs: ["install", "-r", "requirements.txt"],
    fallbackArgs: ["install", "-e", "."],
  },
  gates: [
    {
      id: "lint",
      name: "Ruff Lint",
      command: "ruff check .",
      timeoutMs: 120000,
      required: true,
      when: "pre-merge",
    },
    {
      id: "type-check",
      name: "Mypy Type Check",
      command: "mypy .",
      timeoutMs: 180000,
      required: false, // Not all Python projects use mypy
      when: "pre-merge",
    },
    {
      id: "test",
      name: "Pytest",
      command: "pytest",
      timeoutMs: 300000,
      required: true,
      when: "pre-merge",
    },
  ],
};

// =============================================================================
// PRESET REGISTRY
// =============================================================================

const PRESETS: Record<PresetName, Preset> = {
  "node-pnpm": nodePnpmPreset,
  "node-npm": nodeNpmPreset,
  "node-yarn": nodeYarnPreset,
  "node-bun": nodeBunPreset,
  rust: rustPreset,
  go: goPreset,
  python: pythonPreset,
};

// =============================================================================
// PRESET API
// =============================================================================

/**
 * Check if a string is a valid preset name.
 */
export function isPresetName(name: string): name is PresetName {
  return name in PRESETS;
}

/**
 * Get a preset by name.
 */
export function getPreset(name: PresetName): Preset | null {
  return PRESETS[name] || null;
}

/**
 * Get all available preset names.
 */
export function getPresetNames(): PresetName[] {
  return Object.keys(PRESETS) as PresetName[];
}

/**
 * Get preset description for documentation.
 */
export function getPresetDescription(name: PresetName): string {
  const descriptions: Record<PresetName, string> = {
    "node-pnpm": "Node.js project with pnpm package manager",
    "node-npm": "Node.js project with npm package manager",
    "node-yarn": "Node.js project with Yarn package manager",
    "node-bun": "Node.js project with Bun runtime",
    rust: "Rust project with Cargo",
    go: "Go project with Go modules",
    python: "Python project with pip",
  };
  return descriptions[name];
}
