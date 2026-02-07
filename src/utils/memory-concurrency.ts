import { freemem, totalmem } from "os";
import { getRunnerConfig } from "../store/state.js";

/**
 * Memory-based concurrency calculation result.
 */
export interface MemoryConcurrencyResult {
  /** Free memory in GB */
  freeMemoryGB: number;
  /** Free memory as percentage of total */
  freeMemoryPercent: number;
  /** Calculated concurrency based on available memory */
  calculatedConcurrency: number;
  /** Effective concurrency (min of calculated and max configured) */
  effectiveConcurrency: number;
  /** Maximum configured concurrency */
  maxConcurrency: number;
  /** Whether execution is paused due to insufficient memory */
  pausedDueToMemory: boolean;
}

/**
 * Calculate effective concurrency based on available system memory.
 *
 * Reserves 2GB for system + other apps, each agent needs ~800MB.
 *
 * @returns Memory-based concurrency calculation result
 */
export async function calculateMemoryConcurrency(): Promise<MemoryConcurrencyResult> {
  const runnerConfig = await getRunnerConfig();
  const freeMemBytes = freemem();
  const totalMemBytes = totalmem();
  const freeMemoryPercent = (freeMemBytes / totalMemBytes) * 100;
  const freeMemoryGB = freeMemBytes / (1024 * 1024 * 1024);

  // Reserve 2GB for system + other apps, each agent needs ~800MB
  const RESERVED_GB = 2;
  const MEM_PER_AGENT_GB = 0.8;
  const availableForAgents = Math.max(0, freeMemoryGB - RESERVED_GB);
  const calculatedConcurrency = Math.floor(availableForAgents / MEM_PER_AGENT_GB);
  const effectiveConcurrency = Math.min(calculatedConcurrency, runnerConfig.maxConcurrency);
  const pausedDueToMemory = effectiveConcurrency === 0;

  return {
    freeMemoryGB: Number(freeMemoryGB.toFixed(1)),
    freeMemoryPercent: Number(freeMemoryPercent.toFixed(1)),
    calculatedConcurrency,
    effectiveConcurrency,
    maxConcurrency: runnerConfig.maxConcurrency,
    pausedDueToMemory,
  };
}
