import { z } from "zod";
import { execSync } from "child_process";
import { existsSync, accessSync, constants } from "fs";
import { join } from "path";
import { RALPH_DATA_DIR } from "../store/state.js";

export const doctorInputSchema = z.object({
  projectRoot: z
    .string()
    .optional()
    .describe("Project root directory to check (defaults to cwd)"),
  verbose: z
    .boolean()
    .default(false)
    .describe("Include detailed version info and paths"),
});

export type DoctorInput = z.infer<typeof doctorInputSchema>;

interface CheckResult {
  name: string;
  status: "ok" | "warn" | "error";
  message: string;
  details?: string;
  fix?: string;
}

interface DoctorResult {
  healthy: boolean;
  checks: CheckResult[];
  summary: {
    ok: number;
    warn: number;
    error: number;
  };
  environment: {
    platform: string;
    nodeVersion: string;
    ralphDataDir: string;
  };
}

function runCommand(cmd: string): { success: boolean; output: string } {
  try {
    const output = execSync(cmd, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { success: true, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, output: message };
  }
}

function checkGit(projectRoot: string, verbose: boolean): CheckResult {
  // Check git is installed
  const gitVersion = runCommand("git --version");
  if (!gitVersion.success) {
    return {
      name: "git",
      status: "error",
      message: "Git is not installed or not in PATH",
      fix: "Install Git: https://git-scm.com/downloads",
    };
  }

  // Check we're in a git repo
  const gitRoot = runCommand(`git -C "${projectRoot}" rev-parse --show-toplevel`);
  if (!gitRoot.success) {
    return {
      name: "git",
      status: "error",
      message: `Not a git repository: ${projectRoot}`,
      fix: "Run 'git init' or navigate to a git repository",
    };
  }

  // Check for uncommitted changes (warning only)
  const gitStatus = runCommand(`git -C "${projectRoot}" status --porcelain`);
  const hasUncommitted = gitStatus.success && gitStatus.output.length > 0;

  return {
    name: "git",
    status: hasUncommitted ? "warn" : "ok",
    message: hasUncommitted
      ? "Git repository has uncommitted changes"
      : "Git repository OK",
    details: verbose ? `Version: ${gitVersion.output}, Root: ${gitRoot.output}` : undefined,
    fix: hasUncommitted ? "Consider committing or stashing changes before starting PRD execution" : undefined,
  };
}

function checkNode(verbose: boolean): CheckResult {
  const nodeVersion = runCommand("node --version");
  if (!nodeVersion.success) {
    return {
      name: "node",
      status: "error",
      message: "Node.js is not installed or not in PATH",
      fix: "Install Node.js >= 18: https://nodejs.org/",
    };
  }

  // Parse version (v18.0.0 -> 18)
  const versionMatch = nodeVersion.output.match(/v(\d+)/);
  const majorVersion = versionMatch ? parseInt(versionMatch[1], 10) : 0;

  if (majorVersion < 18) {
    return {
      name: "node",
      status: "error",
      message: `Node.js version ${nodeVersion.output} is too old (requires >= 18)`,
      fix: "Upgrade Node.js to version 18 or later",
    };
  }

  return {
    name: "node",
    status: "ok",
    message: `Node.js ${nodeVersion.output}`,
    details: verbose ? `Major version: ${majorVersion}` : undefined,
  };
}

function checkPackageManager(projectRoot: string, verbose: boolean): CheckResult {
  // Check for pnpm first (preferred)
  const pnpmVersion = runCommand("pnpm --version");
  if (pnpmVersion.success) {
    // Check if pnpm-lock.yaml exists
    const hasPnpmLock = existsSync(join(projectRoot, "pnpm-lock.yaml"));
    return {
      name: "package-manager",
      status: "ok",
      message: `pnpm ${pnpmVersion.output}${hasPnpmLock ? " (lock file found)" : ""}`,
      details: verbose ? `pnpm-lock.yaml: ${hasPnpmLock}` : undefined,
    };
  }

  // Fall back to npm
  const npmVersion = runCommand("npm --version");
  if (npmVersion.success) {
    const hasPackageLock = existsSync(join(projectRoot, "package-lock.json"));
    return {
      name: "package-manager",
      status: "warn",
      message: `npm ${npmVersion.output} (pnpm recommended)`,
      details: verbose ? `package-lock.json: ${hasPackageLock}` : undefined,
      fix: "Consider installing pnpm: npm install -g pnpm",
    };
  }

  return {
    name: "package-manager",
    status: "error",
    message: "No package manager found (pnpm or npm)",
    fix: "Install pnpm: npm install -g pnpm",
  };
}

function checkWorktreeSupport(projectRoot: string): CheckResult {
  // Check git worktree is available
  const worktreeList = runCommand(`git -C "${projectRoot}" worktree list`);
  if (!worktreeList.success) {
    return {
      name: "worktree",
      status: "error",
      message: "Git worktree command failed",
      fix: "Ensure git version >= 2.5 for worktree support",
    };
  }

  // Check parent directory is writable (for creating worktrees)
  const parentDir = join(projectRoot, "..");
  try {
    accessSync(parentDir, constants.W_OK);
  } catch {
    return {
      name: "worktree",
      status: "error",
      message: `Parent directory is not writable: ${parentDir}`,
      fix: "Ensure write permissions on the parent directory",
    };
  }

  return {
    name: "worktree",
    status: "ok",
    message: "Git worktree support OK",
  };
}

function checkRalphDataDir(): CheckResult {
  // Check data directory exists and is writable
  if (!existsSync(RALPH_DATA_DIR)) {
    return {
      name: "ralph-data",
      status: "warn",
      message: `Ralph data directory does not exist: ${RALPH_DATA_DIR}`,
      details: "Will be created on first use",
    };
  }

  try {
    accessSync(RALPH_DATA_DIR, constants.W_OK);
  } catch {
    return {
      name: "ralph-data",
      status: "error",
      message: `Ralph data directory is not writable: ${RALPH_DATA_DIR}`,
      fix: `Check permissions on ${RALPH_DATA_DIR}`,
    };
  }

  return {
    name: "ralph-data",
    status: "ok",
    message: `Ralph data directory OK: ${RALPH_DATA_DIR}`,
  };
}

function checkProjectStructure(projectRoot: string): CheckResult {
  // Check for package.json
  const hasPackageJson = existsSync(join(projectRoot, "package.json"));
  if (!hasPackageJson) {
    return {
      name: "project-structure",
      status: "warn",
      message: "No package.json found in project root",
      fix: "Run 'npm init' or 'pnpm init' to create package.json",
    };
  }

  // Check for common task directories
  const hasTasksDir = existsSync(join(projectRoot, "tasks"));
  const hasPrdsDir = existsSync(join(projectRoot, "prds"));

  return {
    name: "project-structure",
    status: "ok",
    message: `Project structure OK${hasTasksDir ? " (tasks/ found)" : ""}${hasPrdsDir ? " (prds/ found)" : ""}`,
  };
}

function checkDiskSpace(): CheckResult {
  // Simple check - try to get disk info (platform-specific)
  if (process.platform === "win32") {
    // On Windows, use wmic
    const diskInfo = runCommand("wmic logicaldisk get size,freespace,caption");
    if (diskInfo.success) {
      return {
        name: "disk-space",
        status: "ok",
        message: "Disk space check passed",
        details: diskInfo.output.split("\n").slice(0, 3).join("; "),
      };
    }
  } else {
    // On Unix, use df
    const diskInfo = runCommand("df -h . | tail -1");
    if (diskInfo.success) {
      return {
        name: "disk-space",
        status: "ok",
        message: "Disk space check passed",
        details: diskInfo.output,
      };
    }
  }

  return {
    name: "disk-space",
    status: "warn",
    message: "Could not check disk space",
  };
}

export async function doctor(input: DoctorInput): Promise<DoctorResult> {
  const projectRoot = input.projectRoot || process.cwd();
  const verbose = input.verbose;

  const checks: CheckResult[] = [
    checkNode(verbose),
    checkGit(projectRoot, verbose),
    checkPackageManager(projectRoot, verbose),
    checkWorktreeSupport(projectRoot),
    checkRalphDataDir(),
    checkProjectStructure(projectRoot),
    checkDiskSpace(),
  ];

  const summary = {
    ok: checks.filter((c) => c.status === "ok").length,
    warn: checks.filter((c) => c.status === "warn").length,
    error: checks.filter((c) => c.status === "error").length,
  };

  const healthy = summary.error === 0;

  return {
    healthy,
    checks,
    summary,
    environment: {
      platform: process.platform,
      nodeVersion: process.version,
      ralphDataDir: RALPH_DATA_DIR,
    },
  };
}
