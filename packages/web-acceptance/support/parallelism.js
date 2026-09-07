/**
 * How many Cucumber workers this run should start.
 *
 * Lives in plain JS because `cucumber.js` is loaded by cucumber-js's own ESM
 * loader — the one loader in this package that is not bun's, and the one that
 * need not read TypeScript.
 */

import { availableParallelism } from "node:os";

/**
 * Past this, another worker costs more than it saves.
 *
 * A worker here is far heavier than a browser. It holds a Chromium AND an `odu
 * web-daemon` of its own AND, for every scenario with a live run, a coordinator
 * that evaluates a flake and realises `odu-runner` — plus the `just` recipes
 * that run underneath it. Two of those already saturates a four-core CI runner,
 * and a starved coordinator does not fail cleanly: it misses a deadline and the
 * scenario reads as a UI flake. A 64-core box is not a reason to spawn 63.
 */
/** @type {number} */
export const WORKER_CAP = 2;

/** `os.availableParallelism()` minus one, floored at 1, capped at
 *  {@link WORKER_CAP}.
 *
 *  Minus one leaves a core for the kernel and this coordinator process, so a
 *  two-core box still runs — serially — rather than fighting itself. */
/** @param {number} cpus
 *  @returns {number} */
export const defaultWorkers = (cpus) =>
  Math.max(1, Math.min(WORKER_CAP, cpus - 1));

/**
 * `CUCUMBER_PARALLEL` is the override, including `=1` for a serial run. Unset
 * (or empty) derives from the machine. A value that is not a positive integer
 * is a setup mistake and is REFUSED rather than silently becoming serial —
 * `parseInt("no")` is `NaN`, and `NaN > 1` being false is how that used to hide.
 */
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
