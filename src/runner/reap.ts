/**
 * How a recipe process tree dies — the one owner of that volatility.
 *
 * Every recipe node is spawned `detached` (its own process group), which
 * deliberately decouples the tree from the runner's own death — so the ONLY
 * thing that ever kills a recipe tree is an explicit group kill from here.
 * Before this module, three teardown paths never (or only partially) did
 * that, and the recipe's descendants (test drivers, package managers, vitest
 * workers) reparented to init and leaked forever on CI boxes:
 *
 *   - the runner killed by a signal — a localhost lane's `session.destroy()`
 *     SIGTERMs the odu-runner process directly (surface-remote's connector
 *     `teardown()`), and with no handler installed the runner died without
 *     any group kill at all;
 *   - `node.cancel` / `node.rerun` — one SIGTERM, never escalated, and the
 *     group forgotten immediately (a TERM-ignoring tree leaked forever);
 *   - a node finishing while a stray it backgrounded was still alive in its
 *     group — nothing ever looked at the group again.
 *
 * One mechanism for all of them: every spawned group is tracked from birth,
 * and every removal goes through SIGTERM → bounded grace → SIGKILL. `reap`
 * is the async in-run form (cancel / rerun / node exit); `reapAllSync` is
 * the process-exit form — synchronous, because its callers (the stdin-EOF
 * dispose before the framework-owned exit, the signal handlers in main.ts)
 * sit on paths where the process exits as soon as they return, so a
 * timer-based escalation would never fire.
 *
 * Residual (the recipe's own contract, not chased here): a recipe child that
 * calls setsid() itself — a self-daemonizing process — leaves the group and
 * cannot be reached by a group kill. Likewise a nix-daemon build runs under
 * the daemon, not in the recipe's group; the SIGTERM grace exists precisely
 * so the `nix` client gets a chance to propagate cancellation to the daemon
 * before dying.
 */

/** How long a group gets after SIGTERM before SIGKILL. Matches the grace
 *  surface-remote's fire-and-collect helpers use for the same escalation. */
export const TERM_GRACE_MS = 2000;

export interface GroupReaper {
  /** Start owning a spawned group. Call with the direct child's pid — the
   *  group leader, thanks to `detached: true`. */
  track(pgid: number): void;
  /** TERM the group now; KILL whatever survives the grace. Idempotent, and a
   *  group already gone is simply untracked. */
  reap(pgid: number): void;
  /** Process-exit sweep: TERM every live tracked group, wait out the grace
   *  synchronously (polling group liveness), KILL survivors. Returns only
   *  once every tracked group is dead or SIGKILLed. */
  reapAllSync(): void;
}

/** Signal-0 probe: does any member of the group survive? Falls back to the
 *  bare pid for the sliver where the child has forked but not yet setsid'd. */
function groupAlive(pgid: number): boolean {
  for (const target of [-pgid, pgid]) {
    try {
      process.kill(target, 0);
      return true;
    } catch {
      /* try the next form */
    }
  }
  return false;
}

/** Signal the whole group; fall back to the bare pid (pre-setsid race). */
function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  for (const target of [-pgid, pgid]) {
    try {
      process.kill(target, signal);
      return;
    } catch {
      /* group/process already gone, or not yet a group — try the next form */
    }
  }
}

/** Bounded synchronous sleep for the process-exit sweep (the event loop is
 *  about to die; timers would never fire). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function createGroupReaper(
  opts: {
    /** Injected grace for tests; production callers take the default. */
    graceMs?: number;
  } = {},
): GroupReaper {
  const graceMs = opts.graceMs ?? TERM_GRACE_MS;
  /** pgid → pending SIGKILL escalation timer (null = tracked, not reaping). */
  const tracked = new Map<number, ReturnType<typeof setTimeout> | null>();

  return {
    track: (pgid) => {
      if (!tracked.has(pgid)) tracked.set(pgid, null);
    },

    reap: (pgid) => {
      const timer = tracked.get(pgid);
      if (timer === undefined || timer !== null) return; // untracked / already reaping
      if (!groupAlive(pgid)) {
        tracked.delete(pgid);
        return;
      }
      signalGroup(pgid, "SIGTERM");
      const escalation = setTimeout(() => {
        if (groupAlive(pgid)) signalGroup(pgid, "SIGKILL");
        tracked.delete(pgid);
      }, graceMs);
      escalation.unref?.();
      tracked.set(pgid, escalation);
    },

    reapAllSync: () => {
      const live: number[] = [];
      for (const [pgid, timer] of tracked) {
        if (timer !== null) clearTimeout(timer);
        if (!groupAlive(pgid)) continue;
        signalGroup(pgid, "SIGTERM");
        live.push(pgid);
      }
      tracked.clear();
      let survivors = live;
      const deadline = Date.now() + graceMs;
      while (survivors.length > 0 && Date.now() < deadline) {
        sleepSync(50);
        survivors = survivors.filter(groupAlive);
      }
      for (const pgid of survivors) signalGroup(pgid, "SIGKILL");
    },
  };
}
