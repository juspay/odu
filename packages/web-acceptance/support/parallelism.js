/**
 * Lives in plain JS because `cucumber.js` is loaded by cucumber-js's own ESM
 * loader — the one loader in this package that is not bun's, and the one that
 * need not read TypeScript.
 */

import { availableParallelism } from "node:os";

/** @type {number} */
export const WORKER_CAP = 2;

/** @param {number} cpus
 *  @returns {number} */
export const defaultWorkers = (cpus) =>
  Math.max(1, Math.min(WORKER_CAP, cpus - 1));

/** @param {NodeJS.ProcessEnv} [env]
 *  @param {() => number} [available]
 *  @returns {number} */
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
