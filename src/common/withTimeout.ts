/**
 * `withTimeout` — bound a promise by a deadline, or (with a `heartbeat`) by
 * SILENCE.
 *
 * Lives in `common/` because it is not about leases and not about lanes: it is
 * a promise combinator over time, and the difference between "finish within
 * `ms`" and "go quiet for `ms`" is a distinction two unrelated parts of the
 * coordinator both need. `lease.ts` needed it first — a cold host cannot be
 * provisioned under an absolute bound, because the closure copy takes as long
 * as it takes while narrating every store path. `lane.ts` needs the identical
 * shape for its end-of-run log drain: a backlog on a slow link must cost time
 * rather than output, and only a lane that has stopped talking altogether is
 * lost. One primitive, two callers, and `lease.ts` keeps only lease concerns.
 */

export interface TimeoutOpts {
  /** Hands the caller a `bump` that RESTARTS the countdown, turning the bound
   *  from "finish within `ms`" into "go quiet for `ms`". Wire it to a real
   *  progress signal only — a bump with no evidence behind it is an unbounded
   *  wait wearing a timeout's clothes.
   *
   *  A `bump` after the call settles (either way) is a no-op — callers need not
   *  unwire it, and a second guard at the call site would only be a weaker copy
   *  of this one. */
  heartbeat?: (bump: () => void) => void;
  /** Appended to the timeout message: what the call was waiting ON, so the
   *  refusal is a diagnosis rather than a duration. */
  note?: () => string;
  /** Total-elapsed backstop that a `bump` can NEVER re-arm. Only meaningful
   *  beside a `heartbeat`: an idle bound is unbounded in total time by
   *  construction, so a peer that narrates forever without finishing needs this
   *  to have any terminal bound at all. Set it generously — it is the last
   *  resort, not the working deadline. */
  ceilingMs?: number;
}

/** The heartbeat turns an absolute bound into an idle one, and that difference
 *  is the whole of whether a cold host can be provisioned at all — and of
 *  whether a lane's log backlog costs time or output. Unit-tested on its own
 *  (`lease.provisioning.test.ts`), without an ssh session. */
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
    /** This call is over: stop both timers and refuse further bumps. */
    const finish = (): void => {
      settled = true;
      clearTimeout(t);
      if (ceiling !== undefined) clearTimeout(ceiling);
    };
    // A timeout SETTLES the promise too, so it finishes exactly as a resolution
    // does — otherwise a bump arriving afterwards re-arms a fresh timer against
    // an already-rejected promise, and since the heartbeat fires on every
    // session line that repeats for as long as the peer keeps talking.
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
      // Armed once and never re-armed — this is the bound a bump cannot move.
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
