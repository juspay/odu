import { availableParallelism } from "node:os";

export const WORKERS_A_FOUR_CORE_RUNNER_SURVIVES = 2;

export const defaultWorkers = (cpus) =>
  Math.max(1, Math.min(WORKERS_A_FOUR_CORE_RUNNER_SURVIVES, cpus - 1));

export const workerCount = (
  env = process.env,
  available = availableParallelism,
) => {
  const raw = env.CUCUMBER_PARALLEL;
  if (raw !== undefined && raw !== "") {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(
        `CUCUMBER_PARALLEL must be a positive integer, got ${JSON.stringify(raw)}`,
      );
    }
    return n;
  }
  return defaultWorkers(available());
};
