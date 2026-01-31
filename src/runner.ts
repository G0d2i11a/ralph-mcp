import {
  listExecutions,
  updateExecution,
  findExecutionByBranch,
  ExecutionRecord,
} from "./store/state.js";
import { claimReady } from "./tools/claim-ready.js";
import { setAgentId } from "./tools/set-agent-id.js";

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
  error?: string;
}

/** Launcher interface - implemented by launcher.ts */
export interface AgentLauncher {
  launch(prompt: string, cwd: string): Promise<LaunchResult>;
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
    this.log("info", `Runner started (interval: ${this.config.interval}ms, concurrency: ${this.config.concurrency})`);

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
      // First, check for timed-out starting PRDs
      await this.recoverTimedOutPrds();

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
   * Find and process all ready PRDs.
   */
  private async processReadyPrds(): Promise<void> {
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

      // Update execution with agent ID and set to running
      const agentTaskId = launchResult.agentTaskId!;
      await setAgentId({ branch, agentTaskId });
      await updateExecution(prd.id, {
        status: "running",
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
