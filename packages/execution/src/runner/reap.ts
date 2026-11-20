export const TERM_GRACE_MS = 2000;

export interface GroupReaper {
  track(pgid: number): void;
  reap(pgid: number): void;
  reapAllSync(): void;
}

/** Falls back to the bare pid for the sliver where the child has forked but
 *  not yet setsid'd. */
function groupAlive(pgid: number): boolean {
  for (const target of [-pgid, pgid]) {
    try {
      process.kill(target, 0);
      return true;
    } catch {
    }
  }
  return false;
}

/** Falls back to the bare pid (pre-setsid race). */
function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  for (const target of [-pgid, pgid]) {
    try {
      process.kill(target, signal);
      return;
    } catch {
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function createGroupReaper(
  opts: {
    graceMs?: number;
  } = {},
): GroupReaper {
  const graceMs = opts.graceMs ?? TERM_GRACE_MS;
  const tracked = new Map<number, ReturnType<typeof setTimeout> | null>();

  return {
    track: (pgid) => {
      if (!tracked.has(pgid)) tracked.set(pgid, null);
    },

    reap: (pgid) => {
      const timer = tracked.get(pgid);
      if (timer === undefined || timer !== null) return;
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
