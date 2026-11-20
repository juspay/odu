export const TERM_GRACE_MS = 2000;

export interface GroupReaperOptions {
  graceMs?: number;
}

export interface GroupReaper {
  track(childPid: number): void;
  reap(childPid: number): void;
  reapAllAndWaitForDeath(): void;
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

function sleepSyncOnExitPath(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function createGroupReaper(opts: GroupReaperOptions = {}): GroupReaper {
  const graceMs = opts.graceMs ?? TERM_GRACE_MS;
  const tracked = new Map<
    number,
    { escalation: ReturnType<typeof setTimeout> } | "idle"
  >();

  return {
    track: (childPid) => {
      if (!tracked.has(childPid)) tracked.set(childPid, "idle");
    },

    reap: (childPid) => {
      if (tracked.get(childPid) !== "idle") return;
      if (!groupAlive(childPid)) {
        tracked.delete(childPid);
        return;
      }
      signalGroup(childPid, "SIGTERM");
      const escalation = setTimeout(() => {
        if (groupAlive(childPid)) signalGroup(childPid, "SIGKILL");
        tracked.delete(childPid);
      }, graceMs);
      escalation.unref?.();
      tracked.set(childPid, { escalation });
    },

    reapAllAndWaitForDeath: () => {
      const live: number[] = [];
      for (const [childPid, state] of tracked) {
        if (state !== "idle") clearTimeout(state.escalation);
        if (!groupAlive(childPid)) continue;
        signalGroup(childPid, "SIGTERM");
        live.push(childPid);
      }
      tracked.clear();
      let survivors = live;
      const deadline = Date.now() + graceMs;
      while (survivors.length > 0 && Date.now() < deadline) {
        sleepSyncOnExitPath(50);
        survivors = survivors.filter(groupAlive);
      }
      for (const childPid of survivors) signalGroup(childPid, "SIGKILL");
    },
  };
}
