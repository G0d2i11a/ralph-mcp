#!/usr/bin/env node
import { Runner } from "./runner.js";
import { ClaudeLauncher } from "./utils/launcher.js";
import { createCodexLauncher } from "./utils/codex-launcher.js";
import { existsSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getRunnerConfig, listLiveMcpClients, listExecutions, RALPH_DATA_DIR } from "./store/state.js";
import { acquireRunnerSingleton, type SingletonHandle } from "./utils/runner-singleton.js";
import { loadConfig } from "./config/loader.js";

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

interface CliOptions {
  interval: number;
  concurrency: number;
  maxRetries: number;
  timeout: number;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
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
  -h, --help           Show this help message

Examples:
  ralph-runner                           # Start with defaults
  ralph-runner --interval 10000          # Poll every 10 seconds
  ralph-runner --concurrency 3           # Launch up to 3 PRDs concurrently
  ralph-runner --max-retries 5           # Allow 5 retry attempts

The Runner polls for PRDs in 'ready' status and automatically starts them
using the Claude CLI. It handles crash recovery by detecting timed-out
launches and retrying up to the max-retries limit.

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
  console.log("");

  // Load config to determine agent provider
  const loadedConfig = await loadConfig(process.cwd());
  const agentProvider = loadedConfig.config.agent?.provider ?? "claude";

  // Create launcher based on provider
  const launcher = agentProvider === "codex"
    ? createCodexLauncher({
        onLog: log,
        codexPath: loadedConfig.config.agent?.codex?.codexPath,
        approvalPolicy: loadedConfig.config.agent?.codex?.approvalPolicy,
        sandboxMode: loadedConfig.config.agent?.codex?.sandboxMode,
        level: loadedConfig.config.agent?.codex?.level,
        maxRecoveryAttempts: loadedConfig.config.agent?.codex?.maxRecoveryAttempts,
        stallTimeoutMinutes: loadedConfig.config.agent?.codex?.stallTimeoutMinutes,
      })
    : new ClaudeLauncher({ onLog: log });

  log("info", `  Agent provider: ${agentProvider}`);
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

  // Start the runner
  log("info", "Starting Runner...");
  runner.start();

  // Keep the process alive
  await new Promise<void>(() => {
    // This promise never resolves - we exit via signal handlers
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
