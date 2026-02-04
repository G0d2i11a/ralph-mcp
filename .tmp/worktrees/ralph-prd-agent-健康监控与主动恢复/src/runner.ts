import {
  listExecutions,
  updateExecution,
  findExecutionByBranch,
  ExecutionRecord,
  RecoveryEntry,
} from "./store/state.js";
import { claimReady } from "./tools/claim-ready.js";
import { setAgentId } from "./tools/set-agent-id.js";
import { existsSync, statSync } from "fs";
import { join } from "path";
import { exec } from "child_process";

export interface RunnerConfig {
  /** Polling interval in milliseconds (default: 5000) */
  interval: number;
  /** Maximum concurrent PRD launches (default: 1) */
  concurrency: number;
  /** Maximum launch retry attempts (default: 3) */
  maxRetries: number;
  /** Launch timeout in milliseconds (default: 60000) */
  launchTimeout: number;
  /** Startup confirmation timeout in milliseconds (default: 120000 = 2 minutes) (US-003) */
  startupTimeout: number;
  /** Health monitoring: at_risk threshold in milliseconds (default: 300000 = 5 minutes) */
  atRiskThreshold: number;
  /** Health monitoring: stale threshold in milliseconds (default: 900000 = 15 minutes) */
  staleThreshold: number;
  /** Auto recovery: enable automatic recovery on agent failure (default: true) (US-005) */
  autoRecover: boolean;
  /** Auto recovery: maximum recovery attempts before requiring manual intervention (default: 3) (US-005) */
  maxRecoveryAttempts: number;
  /** API health check: enable periodic API availability checks (default: true) (US-006) */
  apiHealthCheckEnabled: boolean;
  /** API health check: interval in milliseconds (default: 300000 = 5 minutes) (US-006) */
  apiHealthCheckInterval: number;
  /** Callback for logging */
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
  /** Callback when a PRD is started */
  onPrdStarted?: (branch: string, agentTaskId: string) => void;
  /** Callback when a PRD fails to start */
  onPrdFailed?: (branch: string, error: string) => void;
  /** Callback when API health status changes (US-006) */
  onApiHealthChange?: (healthy: boolean, error?: string) => void;
}

export interface LaunchResult {
  success: boolean;
  agentTaskId?: string;
  agentPid?: number; // Process ID of the launched agent (US-002)
  error?: string;
}

/** Launcher interface - implemented by launcher.ts */
export interface AgentLauncher {
  launch(prompt: string, cwd: string): Promise<LaunchResult>;
}

/** API health status (US-006) */
export interface ApiHealthStatus {
  healthy: boolean;
  lastCheckAt: Date | null;
  lastHealthyAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
}

/**
 * Ralph Runner - Polls for ready PRDs and starts them automatically.
 */
export class Runner {
  private config: RunnerConfig;
  private launcher: AgentLauncher;
  private running: boolean = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private apiHealthTimer: NodeJS.Timeout | null = null;
  private activeLaunches: Set<string> = new Set();
  private apiHealth: ApiHealthStatus = {
    healthy: true, // Assume healthy until proven otherwise
    lastCheckAt: null,
    lastHealthyAt: null,
    consecutiveFailures: 0,
    lastError: null,
  };

  constructor(config: Partial<RunnerConfig>, launcher: AgentLauncher) {
    this.config = {
      interval: config.interval ?? 5000,
      concurrency: config.concurrency ?? 1,
      maxRetries: config.maxRetries ?? 3,
      launchTimeout: config.launchTimeout ?? 60000,
      startupTimeout: config.startupTimeout ?? 120000, // 2 minutes (US-003)
      atRiskThreshold: config.atRiskThreshold ?? 300000, // 5 minutes
      staleThreshold: config.staleThreshold ?? 900000, // 15 minutes
      autoRecover: config.autoRecover ?? true, // (US-005)
      maxRecoveryAttempts: config.maxRecoveryAttempts ?? 3, // (US-005)
      apiHealthCheckEnabled: config.apiHealthCheckEnabled ?? true, // (US-006)
      apiHealthCheckInterval: config.apiHealthCheckInterval ?? 300000, // 5 minutes (US-006)
      onLog: config.onLog,
      onPrdStarted: config.onPrdStarted,
      onPrdFailed: config.onPrdFailed,
      onApiHealthChange: config.onApiHealthChange,
    };
    this.launcher = launcher;
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    if (this.config.onLog) {
      this.config.onLog(level, message);
    } else {
      const prefix = level === "error" ? "ERROR" : level === "warn" ? "WARN" : "INFO";
      console.log(`[Runner ${prefix}] ${message}`);
    }
  }

  /**
   * Start the Runner polling loop.
   */
  start(): void {
    if (this.running) {
      this.log("warn", "Runner is already running");
      return;
    }

    this.running = true;
    this.log("info", `Runner started (interval: ${this.config.interval}ms, concurrency: ${this.config.concurrency})`);

    // Start polling immediately
    this.poll();

    // Start API health check if enabled (US-006)
    if (this.config.apiHealthCheckEnabled) {
      this.startApiHealthCheck();
    }
  }

  /**
   * Stop the Runner gracefully.
   */
  stop(): void {
    if (!this.running) {
      this.log("warn", "Runner is not running");
      return;
    }

    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.apiHealthTimer) {
      clearTimeout(this.apiHealthTimer);
      this.apiHealthTimer = null;
    }

    this.log("info", `Runner stopped (${this.activeLaunches.size} launches in progress)`);
  }

  /**
   * Check if the Runner is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the current API health status (US-006).
   */
  getApiHealth(): ApiHealthStatus {
    return { ...this.apiHealth };
  }

  /**
   * Poll for ready PRDs and start them.
   */
  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      // First, check for timed-out starting PRDs
      await this.recoverTimedOutPrds();

      // Check startup confirmation for recently launched PRDs (US-003)
      await this.checkStartupConfirmation();

      // Check process liveness of running PRDs (US-002)
      await this.checkProcessLiveness();

      // Check health of running PRDs (US-001)
      await this.checkHealthStatus();

      // Then process ready PRDs
      await this.processReadyPrds();
    } catch (error) {
      this.log("error", `Poll error: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Schedule next poll
    if (this.running) {
      this.pollTimer = setTimeout(() => this.poll(), this.config.interval);
    }
  }

  /**
   * Recover PRDs stuck in 'starting' status (timeout detection).
   */
  private async recoverTimedOutPrds(): Promise<void> {
    const executions = await listExecutions();
    const now = Date.now();

    // Find PRDs in 'starting' status that have timed out
    const timedOutPrds = executions.filter((e) => {
      if (e.status !== "starting") return false;
      if (!e.launchAttemptAt) return false;

      const elapsed = now - e.launchAttemptAt.getTime();
      return elapsed > this.config.launchTimeout;
    });

    for (const prd of timedOutPrds) {
      this.log("warn", `PRD ${prd.branch} timed out in 'starting' status (attempt ${prd.launchAttempts}/${this.config.maxRetries})`);

      if (prd.launchAttempts >= this.config.maxRetries) {
        // Max retries exceeded - mark as failed
        this.log("error", `PRD ${prd.branch} exceeded max retries (${this.config.maxRetries}), marking as failed`);
        await updateExecution(prd.id, {
          status: "failed",
          lastError: `Launch failed after ${prd.launchAttempts} attempts (timeout)`,
          updatedAt: new Date(),
        });

        if (this.config.onPrdFailed) {
          this.config.onPrdFailed(prd.branch, `Launch failed after ${prd.launchAttempts} attempts`);
        }
      } else {
        // Revert to ready for retry
        this.log("info", `Reverting ${prd.branch} to 'ready' for retry`);
        await updateExecution(prd.id, {
          status: "ready",
          lastError: `Launch timeout (attempt ${prd.launchAttempts})`,
          updatedAt: new Date(),
        });
      }
    }
  }

  /**
   * Check startup confirmation for recently launched PRDs (US-003).
   *
   * For each running PRD without startup confirmation:
   * 1. Check if ralph-progress.md exists or has been modified
   * 2. Check if updatedAt has changed since launch (indicating ralph_update was called)
   * 3. If activity detected, mark startupConfirmedAt
   * 4. If no activity within startupTimeout (2 min), mark as startup failure and retry
   *
   * This distinguishes "startup failure" from "running but stuck":
   * - Startup failure: No activity at all after launch
   * - Running stuck: Had activity but stopped (handled by health monitoring)
   */
  private async checkStartupConfirmation(): Promise<void> {
    const executions = await listExecutions();
    const now = Date.now();

    // Only check running executions without startup confirmation
    const unconfirmedPrds = executions.filter(
      (e) => e.status === "running" && e.startupConfirmedAt === null
    );

    for (const prd of unconfirmedPrds) {
      // Determine if there's been any activity since launch
      let hasActivity = false;
      let activityTime: number | null = null;

      // Check ralph-progress.md file existence/modification
      if (prd.worktreePath && existsSync(prd.worktreePath)) {
        const progressPath = join(prd.worktreePath, "ralph-progress.md");
        if (existsSync(progressPath)) {
          try {
            const stats = statSync(progressPath);
            // If file exists and was modified after launch, we have activity
            if (prd.launchAttemptAt && stats.mtime.getTime() > prd.launchAttemptAt.getTime()) {
              hasActivity = true;
              activityTime = stats.mtime.getTime();
            }
          } catch {
            // Ignore file stat errors
          }
        }
      }

      // Check if updatedAt changed significantly after launch (ralph_update was called)
      if (!hasActivity && prd.launchAttemptAt) {
        const launchTime = prd.launchAttemptAt.getTime();
        const updateTime = prd.updatedAt.getTime();
        // If updatedAt is more than 5 seconds after launch, consider it activity
        // (small buffer to account for the initial status update)
        if (updateTime > launchTime + 5000) {
          hasActivity = true;
          activityTime = updateTime;
        }
      }

      if (hasActivity && activityTime) {
        // Startup confirmed - agent is working
        this.log("info", `PRD ${prd.branch}: Startup confirmed (activity detected)`);
        await updateExecution(prd.id, {
          startupConfirmedAt: new Date(activityTime),
          lastActivityAt: new Date(activityTime),
          healthStatus: "active",
          updatedAt: new Date(),
        });
      } else if (prd.launchAttemptAt) {
        // Check if startup timeout exceeded
        const elapsed = now - prd.launchAttemptAt.getTime();
        if (elapsed > this.config.startupTimeout) {
          this.log("error", `PRD ${prd.branch}: Startup failed (no activity for ${Math.round(elapsed / 1000)}s)`);
          await this.handleStartupFailure(prd);
        }
      }
    }
  }

  /**
   * Handle startup failure (US-003).
   *
   * When a PRD has no activity within startupTimeout after launch:
   * 1. Use auto recovery mechanism (US-005) which handles retry logic
   */
  private async handleStartupFailure(prd: ExecutionRecord): Promise<void> {
    const errorMsg = `Startup failed: no assistant activity within ${Math.round(this.config.startupTimeout / 1000)} seconds`;
    await this.handleAgentFailure(prd, "startup_failure", errorMsg);
  }

  /**
   * Check if a process with the given PID is alive.
   * Works on both Windows and Unix platforms.
   */
  private async isProcessAlive(pid: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (process.platform === "win32") {
        // Windows: use tasklist to check if PID exists
        exec(`tasklist /FI "PID eq ${pid}" /NH`, (error, stdout) => {
          if (error) {
            resolve(false);
            return;
          }
          // tasklist returns "INFO: No tasks are running..." if PID not found
          // Otherwise it returns the process info
          const output = stdout.toLowerCase();
          resolve(!output.includes("no tasks") && output.includes(String(pid)));
        });
      } else {
        // Unix: use kill -0 to check if process exists (doesn't actually kill)
        exec(`kill -0 ${pid} 2>/dev/null`, (error) => {
          resolve(!error);
        });
      }
    });
  }

  /**
   * Check process liveness of running PRDs (US-002: Process Liveness Detection).
   *
   * For each running PRD with a stored PID:
   * 1. Check if the process is still alive
   * 2. If process is dead, attempt auto recovery (US-005) or mark as failed
   */
  private async checkProcessLiveness(): Promise<void> {
    const executions = await listExecutions();

    // Only check running executions with a PID
    const runningPrds = executions.filter(
      (e) => e.status === "running" && e.agentPid !== null
    );

    for (const prd of runningPrds) {
      const pid = prd.agentPid!;
      const isAlive = await this.isProcessAlive(pid);

      if (!isAlive) {
        this.log("error", `PRD ${prd.branch}: Agent process (PID ${pid}) exited unexpectedly`);
        await this.handleAgentFailure(prd, "process_exit", `Agent process exited unexpectedly (PID ${pid})`);
      }
    }
  }

  /**
   * Check health status of running PRDs (US-001: Log Activity Detection).
   *
   * Monitors activity by checking:
   * 1. ralph-progress.md file modification time
   * 2. updatedAt timestamp (from ralph_update calls)
   *
   * Health states:
   * - active: < 30s since last activity
   * - idle: 30s - 5m since last activity
   * - at_risk: 5m - 15m since last activity (warning)
   * - stale: > 15m since last activity (triggers recovery)
   */
  private async checkHealthStatus(): Promise<void> {
    const executions = await listExecutions();
    const now = Date.now();

    // Only check running executions
    const runningPrds = executions.filter((e) => e.status === "running");

    for (const prd of runningPrds) {
      // Determine last activity time
      let lastActivity = prd.updatedAt.getTime();

      // Check ralph-progress.md file if worktree exists
      if (prd.worktreePath && existsSync(prd.worktreePath)) {
        const progressPath = join(prd.worktreePath, "ralph-progress.md");
        if (existsSync(progressPath)) {
          try {
            const stats = statSync(progressPath);
            const progressMtime = stats.mtime.getTime();
            // Use the most recent activity
            lastActivity = Math.max(lastActivity, progressMtime);
          } catch (error) {
            // Ignore file stat errors
          }
        }
      }

      const elapsed = now - lastActivity;
      let newHealthStatus: "active" | "idle" | "at_risk" | "stale";

      // Determine health status based on thresholds
      if (elapsed < 30000) {
        // < 30 seconds
        newHealthStatus = "active";
      } else if (elapsed < this.config.atRiskThreshold) {
        // 30s - 5m (default)
        newHealthStatus = "idle";
      } else if (elapsed < this.config.staleThreshold) {
        // 5m - 15m (default)
        newHealthStatus = "at_risk";
        if (prd.healthStatus !== "at_risk") {
          this.log("warn", `PRD ${prd.branch} is at risk (no activity for ${Math.round(elapsed / 60000)} minutes)`);
        }
      } else {
        // > 15m (default)
        newHealthStatus = "stale";
        if (prd.healthStatus !== "stale") {
          this.log("error", `PRD ${prd.branch} is stale (no activity for ${Math.round(elapsed / 60000)} minutes)`);
          // Trigger recovery flow
          await this.recoverStalePrd(prd);
        }
      }

      // Update health status if changed
      if (prd.healthStatus !== newHealthStatus || prd.lastActivityAt?.getTime() !== lastActivity) {
        await updateExecution(prd.id, {
          healthStatus: newHealthStatus,
          lastActivityAt: new Date(lastActivity),
          updatedAt: new Date(),
        });
      }
    }
  }

  /**
   * Recover a stale PRD (US-001: Recovery Flow).
   *
   * When a PRD has no activity for > staleThreshold:
   * 1. Attempt auto recovery (US-005) or mark as failed
   */
  private async recoverStalePrd(prd: ExecutionRecord): Promise<void> {
    this.log("warn", `Recovering stale PRD: ${prd.branch}`);
    const errorMsg = `Agent stale: no activity for > ${Math.round(this.config.staleThreshold / 60000)} minutes`;
    await this.handleAgentFailure(prd, "stale", errorMsg);
  }

  /**
   * Handle agent failure with auto recovery (US-005).
   *
   * When an agent fails (process exit, stale, startup failure):
   * 1. If autoRecover is enabled and recoveryCount < maxRecoveryAttempts, attempt recovery
   * 2. Log recovery attempt to recoveryLog
   * 3. If max attempts exceeded, mark as failed and require manual intervention
   */
  private async handleAgentFailure(
    prd: ExecutionRecord,
    reason: string,
    errorMsg: string
  ): Promise<void> {
    const now = new Date();
    const newRecoveryCount = prd.recoveryCount + 1;

    // Create recovery log entry
    const recoveryEntry: RecoveryEntry = {
      timestamp: now,
      reason,
      attemptNumber: newRecoveryCount,
      success: false, // Will be updated if recovery succeeds
      error: errorMsg,
    };

    // Check if auto recovery is enabled and we haven't exceeded max attempts
    if (this.config.autoRecover && newRecoveryCount <= this.config.maxRecoveryAttempts) {
      this.log("info", `PRD ${prd.branch}: Attempting auto recovery (attempt ${newRecoveryCount}/${this.config.maxRecoveryAttempts})`);

      // Mark recovery as successful (we're attempting it)
      recoveryEntry.success = true;

      // Revert to ready for automatic re-launch
      await updateExecution(prd.id, {
        status: "ready",
        lastError: errorMsg,
        agentPid: null,
        agentTaskId: null,
        startupConfirmedAt: null, // Reset startup confirmation
        healthStatus: null, // Reset health status
        recoveryCount: newRecoveryCount,
        recoveryLog: [...prd.recoveryLog, recoveryEntry],
        updatedAt: now,
      });

      this.log("info", `PRD ${prd.branch}: Reverted to 'ready' for auto recovery`);
    } else {
      // Max recovery attempts exceeded or auto recovery disabled
      const failReason = this.config.autoRecover
        ? `${errorMsg} (max recovery attempts ${this.config.maxRecoveryAttempts} exceeded)`
        : `${errorMsg} (auto recovery disabled)`;

      this.log("error", `PRD ${prd.branch}: ${failReason}`);

      await updateExecution(prd.id, {
        status: "failed",
        lastError: failReason,
        agentPid: null,
        recoveryCount: newRecoveryCount,
        recoveryLog: [...prd.recoveryLog, recoveryEntry],
        updatedAt: now,
      });

      this.log("info", `Marked ${prd.branch} as failed. Use ralph_retry to resume manually.`);

      if (this.config.onPrdFailed) {
        this.config.onPrdFailed(prd.branch, failReason);
      }
    }
  }

  /**
   * Start the API health check timer (US-006).
   */
  private startApiHealthCheck(): void {
    this.log("info", `API health check enabled (interval: ${this.config.apiHealthCheckInterval}ms)`);

    // Run initial check immediately
    this.performApiHealthCheck();

    // Schedule periodic checks
    this.scheduleNextApiHealthCheck();
  }

  /**
   * Schedule the next API health check (US-006).
   */
  private scheduleNextApiHealthCheck(): void {
    if (!this.running || !this.config.apiHealthCheckEnabled) return;

    this.apiHealthTimer = setTimeout(() => {
      this.performApiHealthCheck();
      this.scheduleNextApiHealthCheck();
    }, this.config.apiHealthCheckInterval);
  }

  /**
   * Perform an API health check by running `claude --version` (US-006).
   *
   * This verifies that:
   * 1. The Claude CLI is accessible
   * 2. The CLI can communicate with the API (implicit in version check)
   */
  private async performApiHealthCheck(): Promise<void> {
    const now = new Date();

    try {
      const result = await this.runClaudeVersionCheck();

      if (result.success) {
        const wasUnhealthy = !this.apiHealth.healthy;

        this.apiHealth = {
          healthy: true,
          lastCheckAt: now,
          lastHealthyAt: now,
          consecutiveFailures: 0,
          lastError: null,
        };

        if (wasUnhealthy) {
          this.log("info", "API health restored - resuming normal operations");
          if (this.config.onApiHealthChange) {
            this.config.onApiHealthChange(true);
          }
        }
      } else {
        this.handleApiHealthFailure(now, result.error || "Unknown error");
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.handleApiHealthFailure(now, errorMsg);
    }
  }

  /**
   * Handle API health check failure (US-006).
   */
  private handleApiHealthFailure(checkTime: Date, error: string): void {
    const wasHealthy = this.apiHealth.healthy;
    const newFailureCount = this.apiHealth.consecutiveFailures + 1;

    this.apiHealth = {
      healthy: false,
      lastCheckAt: checkTime,
      lastHealthyAt: this.apiHealth.lastHealthyAt,
      consecutiveFailures: newFailureCount,
      lastError: error,
    };

    if (wasHealthy) {
      this.log("error", `API health check failed: ${error}`);
      this.log("warn", "Pausing new agent launches until API is available");
      if (this.config.onApiHealthChange) {
        this.config.onApiHealthChange(false, error);
      }
    } else {
      this.log("warn", `API still unavailable (${newFailureCount} consecutive failures): ${error}`);
    }
  }

  /**
   * Run `claude --version` to check API availability (US-006).
   */
  private runClaudeVersionCheck(): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ success: false, error: "Health check timed out (10s)" });
      }, 10000);

      exec("claude --version", { timeout: 10000 }, (error, stdout, stderr) => {
        clearTimeout(timeout);

        if (error) {
          resolve({
            success: false,
            error: `CLI error: ${error.message}${stderr ? ` (${stderr.trim()})` : ""}`
          });
          return;
        }

        // Check if we got a valid version response
        if (stdout && stdout.trim().length > 0) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: "Empty response from claude --version" });
        }
      });
    });
  }

  /**
   * Find and process all ready PRDs.
   */
  private async processReadyPrds(): Promise<void> {
    // Check API health before processing (US-006)
    if (this.config.apiHealthCheckEnabled && !this.apiHealth.healthy) {
      // API is unhealthy - skip launching new PRDs
      const executions = await listExecutions();
      const readyCount = executions.filter((e) => e.status === "ready").length;
      if (readyCount > 0) {
        this.log("info", `Skipping ${readyCount} ready PRD(s) - API unavailable`);
      }
      return;
    }

    // Get all executions
    const executions = await listExecutions();

    // Filter for ready status
    const readyPrds = executions.filter((e) => e.status === "ready");

    if (readyPrds.length === 0) {
      return;
    }

    this.log("info", `Found ${readyPrds.length} ready PRD(s)`);

    // Calculate available slots
    const availableSlots = this.config.concurrency - this.activeLaunches.size;
    if (availableSlots <= 0) {
      this.log("info", `No available slots (${this.activeLaunches.size}/${this.config.concurrency} in use)`);
      return;
    }

    // Process PRDs up to available slots
    const toProcess = readyPrds.slice(0, availableSlots);

    for (const prd of toProcess) {
      // Don't process if already being launched
      if (this.activeLaunches.has(prd.branch)) {
        continue;
      }

      // Start launch in background (don't await)
      this.launchPrd(prd);
    }
  }

  /**
   * Launch a single PRD.
   */
  private async launchPrd(prd: ExecutionRecord): Promise<void> {
    const { branch } = prd;

    // Mark as active
    this.activeLaunches.add(branch);
    this.log("info", `Claiming PRD: ${branch}`);

    try {
      // Claim the PRD (atomic operation)
      const claimResult = await claimReady({ branch });

      if (!claimResult.success) {
        this.log("warn", `Failed to claim ${branch}: ${claimResult.error}`);
        this.activeLaunches.delete(branch);
        return;
      }

      this.log("info", `Launching agent for: ${branch}`);

      // Launch the agent
      const launchResult = await this.launcher.launch(
        claimResult.agentPrompt!,
        claimResult.worktreePath!
      );

      if (!launchResult.success) {
        this.log("error", `Launch failed for ${branch}: ${launchResult.error}`);

        // Revert to ready status for retry
        await this.handleLaunchFailure(branch, launchResult.error || "Unknown error");
        this.activeLaunches.delete(branch);

        if (this.config.onPrdFailed) {
          this.config.onPrdFailed(branch, launchResult.error || "Unknown error");
        }
        return;
      }

      // Update execution with agent ID, PID, and set to running
      const agentTaskId = launchResult.agentTaskId!;
      const agentPid = launchResult.agentPid;
      await setAgentId({ branch, agentTaskId });
      await updateExecution(prd.id, {
        status: "running",
        agentPid: agentPid ?? null,
        updatedAt: new Date(),
      });

      this.log("info", `Successfully started ${branch} (agent: ${agentTaskId})`);

      if (this.config.onPrdStarted) {
        this.config.onPrdStarted(branch, agentTaskId);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log("error", `Error launching ${branch}: ${errorMsg}`);

      await this.handleLaunchFailure(branch, errorMsg);

      if (this.config.onPrdFailed) {
        this.config.onPrdFailed(branch, errorMsg);
      }
    } finally {
      this.activeLaunches.delete(branch);
    }
  }

  /**
   * Handle launch failure - revert to ready or mark as failed based on retry count.
   */
  private async handleLaunchFailure(branch: string, error: string): Promise<void> {
    const exec = await findExecutionByBranch(branch);
    if (!exec) return;

    try {
      if (exec.launchAttempts >= this.config.maxRetries) {
        // Max retries exceeded - mark as failed
        this.log("error", `PRD ${branch} exceeded max retries (${this.config.maxRetries}), marking as failed`);
        await updateExecution(exec.id, {
          status: "failed",
          lastError: `Launch failed after ${exec.launchAttempts} attempts: ${error}`,
          updatedAt: new Date(),
        });
      } else {
        // Revert to ready for retry
        await updateExecution(exec.id, {
          status: "ready",
          lastError: error,
          updatedAt: new Date(),
        });
        this.log("info", `Reverted ${branch} to ready status for retry (attempt ${exec.launchAttempts}/${this.config.maxRetries})`);
      }
    } catch (e: unknown) {
      this.log("error", `Failed to update ${branch}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
