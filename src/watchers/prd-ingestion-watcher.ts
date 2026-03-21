import { watch, type FSWatcher } from "fs";
import { mkdir, readdir, stat, writeFile, readFile } from "fs/promises";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { start, startInputSchema } from "../tools/start.js";
import { RALPH_DATA_DIR } from "../store/state.js";
import { parsePrdFile } from "../utils/prd-parser.js";

export const DEFAULT_PRD_WATCH_FILE_PATTERN = "^ez4ielts-.*\\.json$";
export const DEFAULT_PRD_WATCH_SCAN_INTERVAL_MS = 15_000;
export const DEFAULT_PRD_WATCH_SETTLE_MS = 1_500;
export const DEFAULT_PRD_WATCH_STATE_PATH = join(RALPH_DATA_DIR, "prd-ingestion-state.json");

type WatchLogLevel = "info" | "warn" | "error";
type SeenOrigin = "bootstrap" | "ingested" | "duplicate";

interface SeenFileRecord {
  path: string;
  branch: string | null;
  seenAt: string;
  origin: SeenOrigin;
}

interface WatcherScopeState {
  watchDir: string;
  filePattern: string;
  initializedAt: string;
  updatedAt: string;
  seenFiles: Record<string, SeenFileRecord>;
}

interface WatcherStateFile {
  version: 1;
  updatedAt: string;
  scopes: Record<string, WatcherScopeState>;
}

export interface PrdIngestionWatcherOptions {
  watchDir?: string;
  filePattern?: string;
  projectRoot?: string;
  statePath?: string;
  scanIntervalMs?: number;
  settleMs?: number;
  worktree?: boolean;
  onLog?: (level: WatchLogLevel, message: string) => void;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function expandHome(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return join(homedir(), filePath.slice(2));
  }
  return filePath;
}

function toAbsolutePath(inputPath: string): string {
  const expanded = expandHome(inputPath.trim());
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function toAbsolutePathOrUndefined(inputPath?: string): string | undefined {
  return inputPath ? toAbsolutePath(inputPath) : undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (!value) return defaultValue;
  return value === "1" || value.toLowerCase() === "true";
}

function readNumberEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function isDuplicateExecutionError(message: string): boolean {
  return (
    message.includes("Execution already exists for branch") ||
    message.includes("Found archived failed execution") ||
    message.includes("Found archived stopped execution")
  );
}

export function isPrdWatchEnabled(): boolean {
  return readBooleanEnv("RALPH_PRD_WATCH_ENABLED", false);
}

export class PrdIngestionWatcher {
  private readonly options: Required<Omit<PrdIngestionWatcherOptions, "onLog" | "projectRoot">> & {
    projectRoot?: string;
  };
  private readonly onLog?: (level: WatchLogLevel, message: string) => void;
  private readonly fileRegex: RegExp;
  private readonly scopeKey: string;
  private watcher: FSWatcher | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private pendingTimers = new Map<string, NodeJS.Timeout>();
  private inFlight = new Set<string>();
  private running = false;
  private state: WatcherStateFile = {
    version: 1,
    updatedAt: nowIso(),
    scopes: {},
  };

  constructor(options: PrdIngestionWatcherOptions = {}) {
    const watchDirInput = firstNonEmpty(options.watchDir, process.env.RALPH_PRD_WATCH_DIR);
    if (!watchDirInput) {
      throw new Error(
        "PRD watcher requires an explicit watch directory. Pass `--watch-prds-dir`, set `watchers.prdIngestion.watchDir`, or set `RALPH_PRD_WATCH_DIR`."
      );
    }

    const watchDir = toAbsolutePath(watchDirInput);
    const filePattern =
      firstNonEmpty(options.filePattern, process.env.RALPH_PRD_WATCH_PATTERN) ||
      DEFAULT_PRD_WATCH_FILE_PATTERN;
    this.fileRegex = new RegExp(filePattern);
    this.scopeKey = `${watchDir}::${filePattern}`;
    this.options = {
      watchDir,
      filePattern,
      projectRoot: toAbsolutePathOrUndefined(
        firstNonEmpty(options.projectRoot, process.env.RALPH_PRD_WATCH_PROJECT_ROOT)
      ),
      statePath: toAbsolutePath(
        firstNonEmpty(options.statePath, process.env.RALPH_PRD_WATCH_STATE_PATH) ||
          DEFAULT_PRD_WATCH_STATE_PATH
      ),
      scanIntervalMs:
        options.scanIntervalMs ||
        readNumberEnv("RALPH_PRD_WATCH_SCAN_INTERVAL_MS", DEFAULT_PRD_WATCH_SCAN_INTERVAL_MS),
      settleMs:
        options.settleMs ||
        readNumberEnv("RALPH_PRD_WATCH_SETTLE_MS", DEFAULT_PRD_WATCH_SETTLE_MS),
      worktree: options.worktree ?? readBooleanEnv("RALPH_PRD_WATCH_WORKTREE", true),
    };
    this.onLog = options.onLog;
  }

  describe(): string {
    const projectRoot = this.options.projectRoot
      ? `, projectRoot=${this.options.projectRoot}`
      : ", projectRoot=from PRD repository";
    return `dir=${this.options.watchDir}, pattern=${this.options.filePattern}${projectRoot}`;
  }

  async start(): Promise<void> {
    if (this.running) return;

    await mkdir(dirname(this.options.statePath), { recursive: true });
    await this.loadState();
    await this.bootstrapCurrentScope();
    await this.scanNow();
    this.startFileWatcher();
    this.scanTimer = setInterval(() => {
      void this.scanNow();
    }, this.options.scanIntervalMs);
    this.scanTimer.unref?.();
    this.running = true;
    this.log("info", `PRD watcher enabled (${this.describe()})`);
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }

    for (const timer of this.pendingTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
    this.inFlight.clear();
    this.running = false;
  }

  async scanNow(): Promise<void> {
    const scope = this.getScope();
    const matches = await this.listMatchingFiles();

    for (const filePath of matches) {
      if (scope.seenFiles[filePath]) continue;
      this.scheduleIngestion(filePath);
    }
  }

  private log(level: WatchLogLevel, message: string): void {
    if (this.onLog) {
      this.onLog(level, message);
      return;
    }

    const prefix = level === "error" ? "ERROR" : level === "warn" ? "WARN" : "INFO";
    console.log(`[PRD Watcher ${prefix}] ${message}`);
  }

  private async loadState(): Promise<void> {
    try {
      const raw = await readFile(this.options.statePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<WatcherStateFile>;
      this.state = {
        version: 1,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
        scopes: typeof parsed.scopes === "object" && parsed.scopes ? parsed.scopes : {},
      };
    } catch {
      this.state = {
        version: 1,
        updatedAt: nowIso(),
        scopes: {},
      };
    }
  }

  private async saveState(): Promise<void> {
    this.state.updatedAt = nowIso();
    await writeFile(this.options.statePath, JSON.stringify(this.state, null, 2), "utf-8");
  }

  private getScope(): WatcherScopeState {
    const scope = this.state.scopes[this.scopeKey];
    if (!scope) {
      throw new Error(`Watcher scope not initialized: ${this.scopeKey}`);
    }
    return scope;
  }

  /**
   * Safe bootstrap behavior:
   * - On the first time a watcher scope is enabled, mark current matching files as seen.
   * - On later restarts, keep the persisted seen set and ingest any unseen files.
   */
  private async bootstrapCurrentScope(): Promise<void> {
    if (this.state.scopes[this.scopeKey]) return;

    const matches = await this.listMatchingFiles();
    const timestamp = nowIso();
    const seenFiles: Record<string, SeenFileRecord> = {};

    for (const filePath of matches) {
      seenFiles[filePath] = {
        path: filePath,
        branch: null,
        seenAt: timestamp,
        origin: "bootstrap",
      };
    }

    this.state.scopes[this.scopeKey] = {
      watchDir: this.options.watchDir,
      filePattern: this.options.filePattern,
      initializedAt: timestamp,
      updatedAt: timestamp,
      seenFiles,
    };
    await this.saveState();

    if (matches.length > 0) {
      this.log("info", `Bootstrapped ${matches.length} existing PRD file(s) as seen`);
    }
  }

  private async listMatchingFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.options.watchDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && this.fileRegex.test(entry.name))
        .map((entry) => resolve(this.options.watchDir, entry.name))
        .sort();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log("warn", `Unable to scan ${this.options.watchDir}: ${message}`);
      return [];
    }
  }

  private startFileWatcher(): void {
    try {
      this.watcher = watch(this.options.watchDir, (_eventType, filename) => {
        if (!filename) {
          void this.scanNow();
          return;
        }

        const fileName = String(filename);
        if (!this.fileRegex.test(fileName)) return;
        this.scheduleIngestion(resolve(this.options.watchDir, fileName));
      });

      this.watcher.on("error", (error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log("warn", `File watcher error: ${message}`);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log("warn", `Unable to watch ${this.options.watchDir}: ${message}`);
    }
  }

  private scheduleIngestion(filePath: string): void {
    const scope = this.getScope();
    if (scope.seenFiles[filePath] || this.pendingTimers.has(filePath) || this.inFlight.has(filePath)) {
      return;
    }

    const timer = setTimeout(() => {
      this.pendingTimers.delete(filePath);
      void this.ingestFile(filePath);
    }, this.options.settleMs);
    timer.unref?.();
    this.pendingTimers.set(filePath, timer);
  }

  private async ingestFile(filePath: string): Promise<void> {
    const scope = this.getScope();
    if (scope.seenFiles[filePath] || this.inFlight.has(filePath)) return;

    this.inFlight.add(filePath);
    try {
      const stable = await this.waitForStableFile(filePath);
      if (!stable) return;

      const projectRoot = this.resolveProjectRoot(filePath);
      if (!projectRoot) {
        throw new Error(
          "Unable to resolve project root from PRD. Set RALPH_PRD_WATCH_PROJECT_ROOT or include repository in the PRD JSON."
        );
      }

      const result = await start(
        startInputSchema.parse({
          prdPath: filePath,
          projectRoot,
          worktree: this.options.worktree,
          queueIfBlocked: true,
        })
      );

      await this.markSeen(filePath, "ingested", result.branch);
      this.log(
        "info",
        `Queued ${basename(filePath)} via Ralph start flow -> ${result.branch} (${result.dependenciesSatisfied ? "ready" : "pending"})`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (isDuplicateExecutionError(message)) {
        let branch: string | null = null;
        try {
          branch = parsePrdFile(filePath).branchName;
        } catch {
          branch = null;
        }
        await this.markSeen(filePath, "duplicate", branch);
        this.log("info", `Skipped duplicate PRD ${basename(filePath)}${branch ? ` -> ${branch}` : ""}`);
        return;
      }

      this.log("warn", `Failed to ingest ${basename(filePath)}: ${message}`);
    } finally {
      this.inFlight.delete(filePath);
    }
  }

  private async waitForStableFile(filePath: string): Promise<boolean> {
    const first = await this.safeStat(filePath);
    if (!first) return false;

    await sleep(Math.max(200, Math.min(this.options.settleMs, 1_000)));

    const second = await this.safeStat(filePath);
    if (!second) return false;

    if (first.size !== second.size || first.mtimeMs !== second.mtimeMs) {
      this.scheduleIngestion(filePath);
      return false;
    }

    return true;
  }

  private async safeStat(filePath: string) {
    try {
      return await stat(filePath);
    } catch {
      return null;
    }
  }

  private resolveProjectRoot(filePath: string): string | null {
    if (this.options.projectRoot) {
      return this.options.projectRoot;
    }

    try {
      const prd = parsePrdFile(filePath);
      const repository = prd.frontmatter.repository;
      if (typeof repository !== "string" || repository.trim().length === 0) {
        return null;
      }

      const expanded = expandHome(repository.trim());
      return isAbsolute(expanded) ? expanded : resolve(dirname(filePath), expanded);
    } catch {
      return null;
    }
  }

  private async markSeen(filePath: string, origin: SeenOrigin, branch: string | null): Promise<void> {
    const scope = this.getScope();
    const timestamp = nowIso();
    scope.seenFiles[filePath] = {
      path: filePath,
      branch,
      seenAt: timestamp,
      origin,
    };
    scope.updatedAt = timestamp;
    await this.saveState();
  }
}
