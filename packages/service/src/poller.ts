export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export const NODE_TIMERS: Timers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms);
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
