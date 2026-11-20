/**
 * Arming the next tick AFTER the current one returns makes the gap a property
 * of the schedule rather than of how fast the disk happens to be: however long
 * a tick takes, the loop is idle for `ms` before the next, and two ticks can
 * never overlap.
 */

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export const NODE_TIMERS: Timers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // The poller must not hold the process open on its own: the daemon's
    // lifetime is the gate's and the listener's, and a bare timer would keep it
    // alive after both were closed — the lingering-daemon class.
    handle.unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function everyAfter(
  fn: () => void,
  ms: number,
  timers: Timers = NODE_TIMERS,
): () => void {
  let stopped = false;
  let handle: unknown;
  const tick = (): void => {
    fn();
    if (!stopped) handle = timers.set(tick, ms);
  };
  handle = timers.set(tick, ms);
  return () => {
    stopped = true;
    timers.clear(handle);
  };
}

export function slowTickReporter(
  budgetMs: number,
  warn: (facts: { durationMs: number; runs: number }) => void,
  everyMs = 60_000,
): (durationMs: number, runs: number, now: number) => void {
  let lastAt = Number.NEGATIVE_INFINITY;
  return (durationMs, runs, now) => {
    if (durationMs <= budgetMs) return;
    if (now - lastAt < everyMs) return;
    lastAt = now;
    warn({ durationMs, runs });
  };
}
