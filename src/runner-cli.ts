#!/usr/bin/env node
import { Runner } from "./runner.js";
import { ClaudeLauncher } from "./utils/launcher.js";
import { existsSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import net, { type Server as NetServer } from "net";
import { getRunnerConfig, RALPH_DATA_DIR } from "./store/state.js";

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

type SingletonHandle = {
  endpoint: string;
  server: NetServer;
  release: () => Promise<void>;
};

const RUNNER_SINGLETON_ENDPOINT =
  process.platform === "win32"
    ? "\\\\.\\pipe\\ralph-runner"
    : join(tmpdir(), "ralph-runner.sock");

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

async function tryConnectSingleton(endpoint: string, timeoutMs: number = 250): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect(endpoint);
    let settled = false;

    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function listenSingleton(endpoint: string): Promise<NetServer> {
  return await new Promise<NetServer>((resolve, reject) => {
    const server = net.createServer((socket) => {
      // We only use the server as a "singleton guard". Close connections immediately.
      socket.end();
    });

    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

async function closeServer(server: NetServer): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function acquireRunnerSingleton(): Promise<SingletonHandle | null> {
  const endpoint = RUNNER_SINGLETON_ENDPOINT;

  // 1) Try connect: if it succeeds, another Runner is active.
  if (await tryConnectSingleton(endpoint)) {
    return null;
  }

  // 2) Try to become the singleton by listening.
  try {
    const server = await listenSingleton(endpoint);
    return {
      endpoint,
      server,
      release: async () => {
        try {
          await closeServer(server);
        } catch {
          // Ignore
        }

        // On Unix, the domain socket file can remain after unclean shutdowns.
        if (process.platform !== "win32") {
          try {
            if (existsSync(endpoint)) unlinkSync(endpoint);
          } catch {
            // Ignore
          }
        }
      },
    };
  } catch (error) {
    // Race: another instance may have started between connect() and listen().
    if (isErrnoException(error) && error.code === "EADDRINUSE") {
      if (await tryConnectSingleton(endpoint)) {
        return null;
      }

      // Stale Unix socket file: remove and retry once.
      if (process.platform !== "win32") {
        try {
          if (existsSync(endpoint)) unlinkSync(endpoint);
        } catch {
          // Ignore
        }

        const server = await listenSingleton(endpoint);
        return {
          endpoint,
          server,
          release: async () => {
            try {
              await closeServer(server);
            } catch {
              // Ignore
            }
            try {
              if (existsSync(endpoint)) unlinkSync(endpoint);
            } catch {
              // Ignore
            }
          },
        };
      }

      return null;
    }

    throw error;
  }
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

type ParentIpcMessage =
  | { type: "ralph:heartbeat"; ts?: number }
  | { type: "ralph:shutdown"; reason?: string }
  | { type: string; [key: string]: unknown };

function installParentWatchdog(onParentGone: (reason: string) => void): () => void {
  const hasIpc = typeof process.send === "function";
  if (!hasIpc) return () => {};

  let lastHeartbeatAt = Date.now();
  const heartbeatTimeoutMs = 15000;
  const checkIntervalMs = 5000;

  const onMessage = (message: ParentIpcMessage): void => {
    if (!message || typeof message !== "object") return;
    if (message.type === "ralph:heartbeat") {
      lastHeartbeatAt = Date.now();
      return;
    }
    if (message.type === "ralph:shutdown") {
      onParentGone(message.reason ? `shutdown requested: ${message.reason}` : "shutdown requested");
    }
  };

  const onDisconnect = (): void => {
    onParentGone("IPC disconnected");
  };

  process.on("message", onMessage);
  process.on("disconnect", onDisconnect);

  const timer = setInterval(() => {
    if (process.connected === false) {
      onParentGone("IPC disconnected");
      return;
    }
    if (Date.now() - lastHeartbeatAt > heartbeatTimeoutMs) {
      onParentGone("heartbeat timeout");
    }
  }, checkIntervalMs);
  timer.unref();

  return () => {
    clearInterval(timer);
    process.off("message", onMessage);
    process.off("disconnect", onDisconnect);
  };
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

  // Create launcher
  const launcher = new ClaudeLauncher({
    onLog: log,
  });

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
  let disposeParentWatchdog: () => void = () => {};

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
      disposeParentWatchdog();
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

  disposeParentWatchdog = installParentWatchdog((reason) => {
    log("warn", `Parent MCP process gone (${reason}); exiting...`);
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
