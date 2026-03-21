#!/usr/bin/env node
import { Runner } from "./runner.js";
import { createLauncher } from "./utils/launcher.js";
import { existsSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { pathToFileURL } from "url";
import { getRunnerConfig, listLiveMcpClients, listExecutions, RALPH_DATA_DIR } from "./store/state.js";
import { acquireRunnerSingleton, type SingletonHandle } from "./utils/runner-singleton.js";
import { getConfig } from "./config/loader.js";
import type { RalphConfig } from "./config/schema.js";
import { PrdIngestionWatcher, isPrdWatchEnabled, type PrdIngestionWatcherOptions } from "./watchers/prd-ingestion-watcher.js";

const RUNNER_PID_FILE = join(RALPH_DATA_DIR, "runner.pid");

function writePidFile(): void {
  try {
    writeFileSync(RUNNER_PID_FILE, String(process.pid), "utf-8");
  } catch {
    // Ignore - not critical
  }
}

function removePidFile(): void {
  try {
    if (existsSync(RUNNER_PID_FILE)) {
      unlinkSync(RUNNER_PID_FILE);
    }
  } catch {
    // Ignore - not critical
  }
}

export interface CliOptions {
  interval: number;
  concurrency: number;
  maxRetries: number;
  timeout: number;
  watchPrds?: boolean;
  watchPrdsDir?: string;
  watchPrdsPattern?: string;
  watchPrdsProjectRoot?: string;
  watchPrdsStatePath?: string;
  watchPrdsScanIntervalMs?: number;
  watchPrdsSettleMs?: number;
  watchPrdsWorktree?: boolean;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

export function resolvePrdWatchOptions(
  options: CliOptions,
  config: RalphConfig
): PrdIngestionWatcherOptions | null {
  const watchConfig = config.watchers.prdIngestion;
  const enabled = options.watchPrds ?? (watchConfig.enabled || isPrdWatchEnabled());

  if (!enabled) {
    return null;
  }

  const watchDir = firstNonEmpty(
    options.watchPrdsDir,
    watchConfig.watchDir,
    process.env.RALPH_PRD_WATCH_DIR
  );

  if (!watchDir) {
    throw new Error(
      "PRD watcher requires an explicit watch directory. Pass `--watch-prds-dir`, set `watchers.prdIngestion.watchDir`, or set `RALPH_PRD_WATCH_DIR`."
    );
  }

  return {
    watchDir,
    filePattern: firstNonEmpty(
      options.watchPrdsPattern,
      watchConfig.filePattern,
      process.env.RALPH_PRD_WATCH_PATTERN
    ),
    projectRoot: firstNonEmpty(
      options.watchPrdsProjectRoot,
      watchConfig.projectRoot,
      process.env.RALPH_PRD_WATCH_PROJECT_ROOT
    ),
    statePath: firstNonEmpty(
      options.watchPrdsStatePath,
      watchConfig.statePath,
      process.env.RALPH_PRD_WATCH_STATE_PATH
    ),
    scanIntervalMs:
      options.watchPrdsScanIntervalMs ?? watchConfig.scanIntervalMs,
    settleMs:
      options.watchPrdsSettleMs ?? watchConfig.settleMs,
    worktree: options.watchPrdsWorktree ?? watchConfig.worktree,
  };
}

export function parseArgs(args = process.argv.slice(2)): CliOptions {
  const options: CliOptions = {
    interval: 5000,
    concurrency: 0, // 0 = auto (use state.json runnerConfig.maxConcurrency)
    maxRetries: 3,
    timeout: 60000,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case "--interval":
        if (nextArg) {
          options.interval = parseInt(nextArg, 10);
          i++;
        }
        break;
      case "--concurrency":
        if (nextArg) {
          options.concurrency = parseInt(nextArg, 10);
          i++;
        }
        break;
      case "--max-retries":
        if (nextArg) {
          options.maxRetries = parseInt(nextArg, 10);
          i++;
        }
        break;
      case "--timeout":
        if (nextArg) {
          options.timeout = parseInt(nextArg, 10);
          i++;
        }
        break;
      case "--watch-prds":
        options.watchPrds = true;
        break;
      case "--no-watch-prds":
        options.watchPrds = false;
        break;
      case "--watch-prds-dir":
        if (nextArg) {
          options.watchPrdsDir = nextArg;
          i++;
        }
        break;
      case "--watch-prds-pattern":
        if (nextArg) {
          options.watchPrdsPattern = nextArg;
          i++;
        }
        break;
      case "--watch-prds-project-root":
        if (nextArg) {
          options.watchPrdsProjectRoot = nextArg;
          i++;
        }
        break;
      case "--watch-prds-state-path":
        if (nextArg) {
          options.watchPrdsStatePath = nextArg;
          i++;
        }
        break;
      case "--watch-prds-scan-interval":
        if (nextArg) {
          options.watchPrdsScanIntervalMs = parseInt(nextArg, 10);
          i++;
        }
        break;
      case "--watch-prds-settle-ms":
        if (nextArg) {
          options.watchPrdsSettleMs = parseInt(nextArg, 10);
          i++;
        }
        break;
      case "--watch-prds-worktree":
        options.watchPrdsWorktree = true;
        break;
      case "--watch-prds-no-worktree":
        options.watchPrdsWorktree = false;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          printHelp();
          process.exit(1);
        }
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
Ralph Runner - Automatically starts ready PRDs

Usage: ralph-runner [options]

Options:
  --interval <ms>      Polling interval in milliseconds (default: 5000)
  --concurrency <n>    Maximum concurrent PRD launches (default: auto from state.json)
  --max-retries <n>    Maximum launch retry attempts (default: 3)
  --timeout <ms>       Launch timeout in milliseconds (default: 60000)
  --watch-prds         Enable PRD ingestion watcher for new JSON PRDs
  --watch-prds-dir <path>
                       Directory to watch for new PRD JSON files
  --watch-prds-pattern <regex>
                       Regex pattern for watched filenames (default: ^ez4ielts-.*\\.json$)
  --watch-prds-project-root <path>
                       Project root override for auto-ingested PRDs
  --watch-prds-state-path <path>
                       Override the watcher state file path
  --watch-prds-scan-interval <ms>
                       Directory rescan interval for the watcher
  --watch-prds-settle-ms <ms>
                       Delay before ingesting a newly written file
  --watch-prds-worktree
                       Force worktree creation for auto-ingested PRDs
  --watch-prds-no-worktree
                       Disable worktree creation for auto-ingested PRDs
  --no-watch-prds      Disable the PRD ingestion watcher even if config enables it
  -h, --help           Show this help message

Examples:
  ralph-runner                           # Start with defaults
  ralph-runner --interval 10000          # Poll every 10 seconds
  ralph-runner --concurrency 3           # Launch up to 3 PRDs concurrently
  ralph-runner --max-retries 5           # Allow 5 retry attempts
  ralph-runner --watch-prds --watch-prds-dir ~/prds

The Runner polls for PRDs in 'ready' status and automatically starts them
using the configured agent backend. CLI is the default path, with SDK kept
available as a fallback/backend override.

When --watch-prds is enabled, you must provide a watch directory explicitly
via --watch-prds-dir, config watchers.prdIngestion.watchDir, or
RALPH_PRD_WATCH_DIR.

Press Ctrl+C to stop the Runner gracefully.
`);
}

function formatTimestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(level: "info" | "warn" | "error", message: string): void {
  const prefix = level === "error" ? "ERROR" : level === "warn" ? "WARN " : "INFO ";
  console.log(`[${formatTimestamp()}] [${prefix}] ${message}`);
}

function installIdleMonitor(
  runner: Runner,
  singleton: SingletonHandle,
  onIdle: () => void
): () => void {
  const CHECK_INTERVAL_MS = 60_000;
  const IDLE_COUNTDOWN_MS = 5 * 60_000;
  let idleSince: number | null = null;

  const timer = setInterval(async () => {
    try {
      // Check for shutdown signal file
      const dataDir = process.env.RALPH_DATA_DIR?.replace("~", homedir()) || join(homedir(), ".ralph");
      const signalPath = join(dataDir, "runner-shutdown-signal");
      if (existsSync(signalPath)) {
        try { unlinkSync(signalPath); } catch { /* ignore */ }
        log("info", "Shutdown signal file detected; exiting...");
        onIdle();
        return;
      }

      const [clients, executions] = await Promise.all([
        listLiveMcpClients(),
        listExecutions(),
      ]);

      const activeExecs = executions.filter(
        (e) => e.status === "running" || e.status === "starting"
      );

      if (clients.length === 0 && activeExecs.length === 0) {
        if (idleSince === null) {
          idleSince = Date.now();
          log("info", "No active MCP clients or executions; idle countdown started (5 min)");
        } else if (Date.now() - idleSince >= IDLE_COUNTDOWN_MS) {
          log("info", "Idle timeout reached; shutting down Runner...");
          onIdle();
          return;
        }
      } else {
        if (idleSince !== null) {
          log("info", "Activity detected; idle countdown reset");
        }
        idleSince = null;
      }
    } catch {
      // Ignore errors in idle check
    }
  }, CHECK_INTERVAL_MS);
  timer.unref();

  return () => clearInterval(timer);
}

async function main(): Promise<void> {
  const options = parseArgs();
  const config = getConfig(process.cwd());
  const prdWatchOptions = resolvePrdWatchOptions(options, config);
  const prdWatcher = prdWatchOptions
    ? new PrdIngestionWatcher({
        ...prdWatchOptions,
        onLog: log,
      })
    : null;

  const singleton = await acquireRunnerSingleton();
  if (!singleton) {
    console.error(
      `[${formatTimestamp()}] [WARN ] Another Ralph Runner instance is already running; exiting.`
    );
    process.exit(0);
  }

  // Write PID file for monitor detection
  writePidFile();

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                      Ralph Runner                              ║
║           Automatic PRD Execution Manager                      ║
╚═══════════════════════════════════════════════════════════════╝
`);

  log("info", "Configuration:");
  log("info", `  Polling interval: ${options.interval}ms`);
  const runnerConfig = await getRunnerConfig();
  const effectiveConcurrency =
    options.concurrency <= 0
      ? runnerConfig.maxConcurrency
      : Math.min(options.concurrency, runnerConfig.maxConcurrency);
  const concurrencyLabel = options.concurrency <= 0 ? "auto" : String(options.concurrency);
  log(
    "info",
    `  Concurrency: ${concurrencyLabel} (effective: ${effectiveConcurrency}, max: ${runnerConfig.maxConcurrency})`
  );
  log("info", `  Max retries: ${options.maxRetries}`);
  log("info", `  Launch timeout: ${options.timeout}ms`);
  const defaultAgentBackend = config.agent.backend ?? "cli";
  const defaultAgentProvider = config.agent.provider ?? "codex";

  const launcher = createLauncher({
    onLog: log,
    launchTimeout: options.timeout,
  });

  log("info", `  Default agent backend: ${defaultAgentBackend}`);
  log("info", `  Default agent provider: ${defaultAgentProvider}`);
  log(
    "info",
    `  PRD ingestion watcher: ${prdWatcher ? `enabled (${prdWatcher.describe()})` : "disabled"}`
  );
  console.log("");

  // Create runner
  const runner = new Runner(
    {
      interval: options.interval,
      concurrency: options.concurrency,
      maxRetries: options.maxRetries,
      launchTimeout: options.timeout,
      onLog: log,
      onPrdStarted: (branch, agentTaskId) => {
        log("info", `PRD started: ${branch} (agent: ${agentTaskId})`);
      },
      onPrdFailed: (branch, error) => {
        log("error", `PRD failed: ${branch} - ${error}`);
      },
    },
    launcher
  );

  // Handle graceful shutdown
  let shuttingDown = false;
  let disposeIdleMonitor: () => void = () => {};

  const shutdown = (): void => {
    if (shuttingDown) {
      log("warn", "Force shutdown...");
      process.exit(1);
    }

    shuttingDown = true;
    log("info", "Shutting down gracefully (press Ctrl+C again to force)...");
    prdWatcher?.stop();
    runner.stop();

    // Give some time for cleanup
    setTimeout(() => {
      disposeIdleMonitor();
      removePidFile();
      Promise.resolve(singleton.release())
        .catch(() => {})
        .finally(() => {
          log("info", "Shutdown complete");
          process.exit(0);
        });
    }, 1000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Install idle monitor instead of parent watchdog
  disposeIdleMonitor = installIdleMonitor(runner, singleton, () => {
    shutdown();
  });

  if (prdWatcher) {
    log("info", "Starting PRD ingestion watcher...");
    await prdWatcher.start();
  }

  // Start the runner
  log("info", "Starting Runner...");
  runner.start();

  // Keep the process alive
  await new Promise<void>(() => {
    // This promise never resolves - we exit via signal handlers
  });
}

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isEntrypoint) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
