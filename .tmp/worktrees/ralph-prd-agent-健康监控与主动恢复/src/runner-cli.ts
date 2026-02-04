#!/usr/bin/env node
import { Runner } from "./runner.js";
import { ClaudeLauncher } from "./utils/launcher.js";

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
    concurrency: 1,
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
  --concurrency <n>    Maximum concurrent PRD launches (default: 1)
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

async function main(): Promise<void> {
  const options = parseArgs();

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                      Ralph Runner                              ║
║           Automatic PRD Execution Manager                      ║
╚═══════════════════════════════════════════════════════════════╝
`);

  log("info", "Configuration:");
  log("info", `  Polling interval: ${options.interval}ms`);
  log("info", `  Concurrency: ${options.concurrency}`);
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
      log("info", "Shutdown complete");
      process.exit(0);
    }, 1000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

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
