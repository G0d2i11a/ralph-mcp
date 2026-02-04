#!/usr/bin/env node
import chokidar from 'chokidar';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { StateLoader } from './state-loader';
import { MonitorUI } from './ui';

// Runner PID file location (same as in runner-cli.ts)
const RALPH_DATA_DIR = process.env.RALPH_DATA_DIR?.replace('~', homedir()) || join(homedir(), '.ralph');
const RUNNER_PID_FILE = join(RALPH_DATA_DIR, 'runner.pid');

/**
 * Check if Runner is currently running by checking PID file.
 */
function checkRunnerStatus(): { running: boolean; pid?: number } {
  if (!existsSync(RUNNER_PID_FILE)) {
    return { running: false };
  }

  try {
    const pidStr = readFileSync(RUNNER_PID_FILE, 'utf-8').trim();
    const pid = parseInt(pidStr, 10);

    if (isNaN(pid)) {
      return { running: false };
    }

    // Check if process is actually running
    try {
      process.kill(pid, 0); // Signal 0 just checks if process exists
      return { running: true, pid };
    } catch {
      // Process doesn't exist (stale PID file)
      return { running: false };
    }
  } catch {
    return { running: false };
  }
}

function main() {
  const stateLoader = new StateLoader();
  const ui = new MonitorUI(stateLoader);

  // Check Runner status and update UI
  const updateRunnerStatus = (): void => {
    const status = checkRunnerStatus();
    if (status.running) {
      ui.setRunnerStatus('running', null);
    } else {
      ui.setRunnerStatus('stopped', 'Runner not running! Start with: pnpm runner');
    }
  };

  // Initial check
  updateRunnerStatus();

  // Initial render
  ui.refresh();

  // Watch state file for changes
  const stateFilePath = stateLoader.getStateFilePath();
  const watcher = chokidar.watch(stateFilePath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50
    }
  });

  watcher.on('change', () => {
    ui.refresh();
  });

  // Also watch Runner PID file
  const pidWatcher = chokidar.watch(RUNNER_PID_FILE, {
    persistent: true,
    ignoreInitial: true,
  });

  pidWatcher.on('all', () => {
    updateRunnerStatus();
    ui.refresh();
  });

  // Auto-refresh every 1 second (fallback)
  setInterval(() => {
    updateRunnerStatus();
    ui.refresh();
  }, 1000);

  // Handle cleanup
  process.on('SIGINT', () => {
    watcher.close();
    pidWatcher.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    watcher.close();
    pidWatcher.close();
    process.exit(0);
  });
}

main();
