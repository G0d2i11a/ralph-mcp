import {
  listExecutions,
  updateExecution,
  findExecutionByBranch,
  ExecutionRecord,
  areDependenciesSatisfied,
  listUserStoriesByExecutionId,
} from "./store/state.js";
import { claimReady } from "./tools/claim-ready.js";
import { setAgentId } from "./tools/set-agent-id.js";
import { retry } from "./tools/retry.js";
import { calculateMemoryConcurrency } from "./utils/memory-concurrency.js";
import { evaluateExecutionStaleness, type StaleDetectionConfig } from "./utils/stale-detection.js";
import { getConfig } from "./config/loader.js";

export interface RunnerConfig {
  /** Polling interval in milliseconds (default: 5000) */
  interval: number;
  /** Maximum concurrent PRD launches (default: 1) */
  concurrency: number;
  /** Maximum launch retry attempts (default: 3) */
  maxRetries: number;
  /** Launch timeout in milliseconds (default: 60000) */
  launchTimeout: number;
  /** Callback for logging */
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
  /** Callback when a PRD is started */
  onPrdStarted?: (branch: string, agentTaskId: string) => void;
  /** Callback when a PRD fails to start */
  onPrdFailed?: (branch: string, error: string) => void;
}

export interface LaunchResult {
  success: boolean;
  agentTaskId?: string;
  logPath?: string | null;
  error?: string;
}

/** Launcher interface - implemented by launcher.ts */
export interface AgentLauncher {
  launch(prompt: string, cwd: string, executionId?: string): Promise<LaunchResult>;
}

/**
 * Ralph Runner - Polls for ready PRDs and starts them automatically.
 */
export class Runner {
  private config: RunnerConfig;
  private launcher: AgentLauncher;
  private running: boolean = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private activeLaunches: Set<string> = new Set();
  private warnedOverConcurrency: boolean = false;

  constructor(config: Partial<RunnerConfig>, launcher: AgentLauncher) {
    this.config = {
      interval: config.interval ?? 5000,
      concurrency: config.concurrency ?? 1,
      maxRetries: config.maxRetries ?? 3,
      launchTimeout: config.launchTimeout ?? 60000,
      onLog: config.onLog,
      onPrdStarted: config.onPrdStarted,
      onPrdFailed: config.onPrdFailed,
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
    const concurrencyLabel =
      this.config.concurrency <= 0 ? "auto" : String(this.config.concurrency);
    this.log(
      "info",
      `Runner started (interval: ${this.config.interval}ms, concurrency: ${concurrencyLabel})`
    );

    // Start polling immediately
    this.poll();
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

    this.log("info", `Runner stopped (${this.activeLaunches.size} launches in progress)`);
  }

  /**
   * Check if the Runner is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Poll for ready PRDs and start them.
   */
  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      // First, reconcile running/failed executions (detect stale agents, fix completed)
      await this.reconcileActiveExecutions();

      // Check for timed-out starting PRDs
      await this.recoverTimedOutPrds();

      // Auto-recover interrupted PRDs (e.g., from Claude Code restart)
      await this.autoRecoverInterrupted();

      // Promote pending PRDs whose dependencies are now satisfied
      await this.promotePendingPrds();

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
   * Reconcile running/failed executions:
   * - Mark stale running PRDs as interrupted
   * - Mark failed PRDs with all stories complete as completed
   */
  private async reconcileActiveExecutions(): Promise<void> {
    const executions = await listExecutions();

    for (const exec of executions) {
      // Skip non-active states and terminal states
      if (!["running", "failed"].includes(exec.status)) continue;

      // Skip PRDs being actively launched by this Runner
      if (this.activeLaunches.has(exec.branch)) continue;

      try {
        // Check story completion for both running and failed
        const stories = await listUserStoriesByExecutionId(exec.id);
        const allComplete = stories.length > 0 && stories.every((s) => s.passes);

        if (allComplete) {
          // Invariant: all stories pass => completed
          this.log("info", `All stories complete for ${exec.branch}, marking completed`);
          await updateExecution(exec.id, {
            status: "completed",
            lastError: null,
            updatedAt: new Date(),
          }, { skipTransitionValidation: true });
          continue;
        }

        // For running PRDs, check if stale
        if (exec.status === "running") {
          const config = getConfig(exec.projectRoot);
          const staleConfig: StaleDetectionConfig = {
            enabled: config.agent.staleDetection.enabled,
            timeoutsMs: config.agent.staleDetection.timeoutsMs,
            signals: config.agent.staleDetection.signals,
            maxFilesToStat: config.agent.staleDetection.maxFilesToStat,
            logTailBytes: config.agent.staleDetection.logTailBytes,
          };

          const decision = await evaluateExecutionStaleness(
            {
              updatedAt: exec.updatedAt,
              currentStep: exec.currentStep,
              lastError: exec.lastError,
              projectRoot: exec.projectRoot,
              worktreePath: exec.worktreePath,
              logPath: exec.logPath,
            },
            staleConfig
          );

          if (decision.isStale) {
            const idleMinutes = Math.round(decision.idleMs / 60000);
            this.log("warn", `${exec.branch} is stale (idle ${idleMinutes}m), marking interrupted`);
            await updateExecution(exec.id, {
              status: "interrupted",
              lastError: `Agent stale: no activity for ${idleMinutes} minutes`,
              updatedAt: new Date(),
            }, { skipTransitionValidation: true });
          }
        }
      } catch (error) {
        this.log("warn", `Failed to reconcile ${exec.branch}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Promote `pending` executions to `ready` once dependencies are satisfied.
   *
   * This enables the Runner to unblock queued PRDs as soon as their dependency PRDs complete.
   */
  async promotePendingPrds(): Promise<void> {
    const executions = await listExecutions();
    const pending = executions.filter((e) => e.status === "pending" && Array.isArray(e.dependencies) && e.dependencies.length > 0);

    for (const exec of pending) {
      try {
        const depStatus = await areDependenciesSatisfied({
          dependencies: exec.dependencies,
          projectRoot: exec.projectRoot,
          prdPath: exec.prdPath,
        });

        if (!depStatus.satisfied) {
          continue;
        }

        await updateExecution(exec.id, {
          status: "ready",
          updatedAt: new Date(),
        });

        this.log("info", `Promoted ${exec.branch} from pending -> ready (deps satisfied)`);
      } catch (error) {
        this.log("warn", `Failed to promote ${exec.branch}: ${error instanceof Error ? error.message : String(error)}`);
      }
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
      // Don't time out PRDs that this Runner is actively launching.
      if (this.activeLaunches.has(e.branch)) return false;

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
   * Auto-recover interrupted PRDs.
   * When Claude Code is restarted, running agents are killed and PRDs become "interrupted".
   * This method automatically calls retry() to set them back to "ready" for the Runner to pick up.
   */
  private async autoRecoverInterrupted(): Promise<void> {
    const executions = await listExecutions();
    const interrupted = executions.filter((e) => e.status === "interrupted");

    for (const exec of interrupted) {
      try {
        this.log("info", `Auto-recovering interrupted PRD: ${exec.branch}`);

        const result = await retry({
          branch: exec.branch,
          wipPolicy: "stash",
        });

        if (result.success) {
          this.log("info", `Auto-recovered ${exec.branch} -> ready (${result.progress.completed}/${result.progress.total} stories)`);
        } else {
          this.log("warn", `Failed to auto-recover ${exec.branch}: ${result.message}`);
        }
      } catch (error) {
        this.log("warn", `Error auto-recovering ${exec.branch}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Find and process all ready PRDs.
   */
  private async processReadyPrds(): Promise<void> {
    // Use dynamic memory-based concurrency calculation
    const memConcurrency = await calculateMemoryConcurrency();
    const effectiveConcurrency =
      this.config.concurrency <= 0
        ? memConcurrency.effectiveConcurrency
        : Math.min(this.config.concurrency, memConcurrency.effectiveConcurrency);

    // Log memory status periodically
    if (memConcurrency.pausedDueToMemory) {
      this.log(
        "warn",
        `Paused due to low memory (${memConcurrency.freeMemoryGB}GB free, need ${2 + 0.8}GB minimum)`
      );
      return;
    }

    // Get all executions
    const executions = await listExecutions();

    // Enforce effective concurrency across the whole system (not just this Runner instance):
    // - running: agents already active
    // - starting: claimed by any Runner, agent launching
    const globalActive = executions.filter((e) => e.status === "running" || e.status === "starting").length;
    const localCountedInState = executions.filter(
      (e) =>
        this.activeLaunches.has(e.branch) &&
        (e.status === "running" || e.status === "starting")
    ).length;
    const localPendingClaims = this.activeLaunches.size - localCountedInState;
    const effectiveInUse = globalActive + Math.max(0, localPendingClaims);

    if (globalActive > effectiveConcurrency) {
      if (!this.warnedOverConcurrency) {
        this.warnedOverConcurrency = true;
        this.log(
          "warn",
          `Global running/starting (${globalActive}) exceeds configured concurrency (${effectiveConcurrency}). Runner will pause launching.`
        );
      }
    } else {
      this.warnedOverConcurrency = false;
    }

    // Filter for ready status
    const readyPrds = executions.filter((e) => e.status === "ready");

    if (readyPrds.length === 0) {
      return;
    }

    this.log("info", `Found ${readyPrds.length} ready PRD(s)`);

    // Calculate available slots
    const availableSlots = effectiveConcurrency - effectiveInUse;
    if (availableSlots <= 0) {
      this.log(
        "info",
        `No available slots (${effectiveInUse}/${effectiveConcurrency} in use)`
      );
      return;
    }

    const priorityRank = (priority: ExecutionRecord["priority"]): number => {
      switch (priority) {
        case "P0":
          return 0;
        case "P1":
          return 1;
        case "P2":
          return 2;
        default:
          return 1;
      }
    };

    // Prefer higher priority first; tie-break by oldest createdAt.
    readyPrds.sort((a, b) => {
      const pa = priorityRank(a.priority);
      const pb = priorityRank(b.priority);
      if (pa !== pb) return pa - pb;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

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
        claimResult.worktreePath!,
        prd.id
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

      // Update execution with agent ID and set to running
      const agentTaskId = launchResult.agentTaskId!;
      await setAgentId({
        branch,
        agentTaskId,
        logPath: launchResult.logPath ?? null,
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
