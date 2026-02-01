#!/usr/bin/env node
import chokidar from 'chokidar';
import { StateLoader } from './state-loader';
import { MonitorUI } from './ui';

function main() {
  const stateLoader = new StateLoader();
  const ui = new MonitorUI(stateLoader);

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

  // Auto-refresh every 5 seconds (fallback)
  setInterval(() => {
    ui.refresh();
  }, 5000);

  // Handle cleanup
  process.on('SIGINT', () => {
    watcher.close();
    process.exit(0);
  });
}

main();
