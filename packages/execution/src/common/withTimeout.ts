export interface TimeoutOpts {
  /** A `bump` RESTARTS the countdown, turning "finish within `ms`" into "go
   *  quiet for `ms`". A bump after the call settles is a no-op. */
  heartbeat?: (bump: () => void) => void;
  note?: () => string;
  /** Total-elapsed backstop that a `bump` can never re-arm. */
  ceilingMs?: number;
}

export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  opts: TimeoutOpts = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let t: ReturnType<typeof setTimeout>;
    let ceiling: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const bound = opts.heartbeat === undefined ? "" : " without progress";
    const finish = (): void => {
      settled = true;
      clearTimeout(t);
      if (ceiling !== undefined) clearTimeout(ceiling);
    };
    const expire = (message: string): void => {
      finish();
      reject(new Error(message));
    };
    const arm = (): void => {
      t = setTimeout(
        () =>
          expire(
            `odu: ${label} timed out after ${ms}ms${bound}${opts.note?.() ?? ""}`,
          ),
        ms,
      );
      t.unref?.();
    };
    arm();
    if (opts.ceilingMs !== undefined) {
      ceiling = setTimeout(
        () =>
          expire(
            `odu: ${label} timed out after ${opts.ceilingMs}ms (absolute ceiling — still reporting progress, never finished)${opts.note?.() ?? ""}`,
          ),
        opts.ceilingMs,
      );
      ceiling.unref?.();
    }
    opts.heartbeat?.(() => {
      if (settled) return;
      clearTimeout(t);
      arm();
    });
    p.then(
      (v) => {
        finish();
        resolve(v);
      },
      (e: unknown) => {
        finish();
        reject(e);
      },
    );
  });
}
