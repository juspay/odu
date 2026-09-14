/**
 * The POLLER's schedule — a tick, then at least `ms` of idle loop, then the next.
 *
 * `setInterval(refresh, 250)` was the schedule before, and it is wrong for any
 * tick that can take longer than its interval: the timer keeps firing on the
 * clock rather than on completion, so a slow refresh is followed immediately by
 * the next one and the event loop never gets a gap. On a host with seven
 * hundred runs that is what happened (juspay/odu#113) — every RPC waited behind
 * a queue of back-to-back refreshes and `odu attach` looked hung.
 *
 * Arming the next tick AFTER the current one returns makes the gap a property
 * of the schedule rather than of how fast the disk happens to be: however long
 * a tick takes, the loop is idle for `ms` before the next, and two ticks can
 * never overlap. A slow catalog then costs freshness, which degrades gently,
 * instead of responsiveness, which does not.
 *
 * Timers are injected so the one property that matters — "the next arm happens
 * after the callback returns" — is a unit test rather than a hope.
 */

/** The two timer calls this needs, and nothing else. */
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

/**
 * Call `fn` every `ms` of idle time until the returned stop is called.
 *
 * A `fn` that throws is not caught here, exactly as it was not under
 * `setInterval`: it surfaces as the process's uncaught exception, and a daemon
 * that cannot read its own catalog ending loudly is better than one that keeps
 * serving a board that has silently stopped moving.
 */
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

/**
 * Say so when a tick outran its interval — at most once per `everyMs`.
 *
 * The report behind #113 had nothing to go on: the daemon was pegged and said
 * nothing. A slow tick is not an error (the schedule above absorbs it), but it
 * is the one fact an operator needs to connect "attach is slow" to "the catalog
 * is large", so it is logged — rate-limited, because a catalog that is slow is
 * slow on every tick.
 */
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
