import { existsSync } from "fs";
import { join } from "path";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

export interface InstallCommand {
  command: string;
  args: string[];
  fallbackArgs: string[]; // Used if strict install fails
}

export function detectPackageManager(projectRoot: string): PackageManager {
  if (existsSync(join(projectRoot, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (existsSync(join(projectRoot, "yarn.lock"))) {
    return "yarn";
  }
  if (existsSync(join(projectRoot, "bun.lockb"))) {
    return "bun";
  }
  // Default to npm if package-lock.json exists or as fallback
  return "npm";
}

export function getInstallCommand(pm: PackageManager): InstallCommand {
  switch (pm) {
    case "pnpm":
      return {
        command: "pnpm",
        args: ["install", "--frozen-lockfile"],
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
    case "npm":
    default:
      return {
        command: "npm",
        args: ["ci"],
        fallbackArgs: ["install"],
      };
  }
}
