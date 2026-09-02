/**
 * `@odu/run-client/deadRun` — the read a dead run never got: a `.ci` that
 * outlived its coordinator.
 *
 * `dialRun` answers `null` for two very different states and, by design, does
 * not tell them apart (see its own header): no run ever ran here — the
 * ordinary steady state — or a run WAS here and its coordinator was killed
 * before it could settle. The first deserves silence; the second is news
 * every face owes an answer for: "this run died", never an empty ledger and
 * never a silent wait.
 *
 * The difference is visible on disk, because a clean exit removes the residue
 * a kill cannot: the run lock's `release()` unlinks its PID file on exit,
 * `serveOverUnixSocket`'s `close()` removes the socket, and a settled run
 * overwrites its reservation sentinel with the finalized record. So the
 * checks, in order:
 *
 *   1. SOMETHING LIVE WINS. A socket that answers, or a run lock whose PID
 *      still answers signal-0, means a coordinator owns this checkout —
 *      answer `null`. (Same signal-0 semantics as the lock's own stale
 *      treatment: a dead-or-foreign PID is not a live coordinator.)
 *   2. RESIDUE IS NEWS. A lock file or socket file nobody serves, or a
 *      `.ci/<sha7>/runs/<seq>.json` still carrying the `reserved` sentinel —
 *      the tombstone a mid-flight kill leaves (odu's ledger documents it as
 *      the reservation a SIGKILL intentionally leaves behind) — means a run
 *      died here. The sentinel names the run (its directory the commit, its
 *      file the seq); the lock and socket can't.
 *
 * What it CANNOT say is honored as ruthlessly as what it can: the death
 * itself is never timestamped (a kill writes nothing), so `lastActivityAt`
 * is the newest mtime among the residue — the last sign of life, not the
 * moment of death. A run killed before it stamped `.ci/<sha7>` left a lock
 * and nothing to name it by: `sha7` is then `""` and no commit is claimed.
 * And a corpse beside LATER healthy history still answers — the death is
 * part of this checkout's story until someone clears the residue.
 *
 * This is the one read of the death; every face (odu's own `runs` /
 * `wait_for_settle` / `node_rerun` / `run`, and a remote watcher's
 * dial-and-find-nothing — the "CI doorbell") answers from it, so they can
 * never disagree about whether a run died here.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { dialRun, runSocketPath } from "./dial";

/** The lock file's name within `.ci` — the writer is odu's
 *  `src/coordinator/checkoutLock.ts`; the spelling is the layout contract
 *  between it and every reader, the way `SOCKET_PATH` is for the socket. */
export const RUN_LOCK_NAME = "odu.run.lock";

/** The reservation sentinel's marker — the named contract odu's ledger
 *  (`src/coordinator/ledger.ts`) writes and reads: a run that reserved a seq
 *  but never finalized its record. Read here by marker alone, never parsed
 *  into a record — the durable RUN RECORD itself stays odu's. */
const RESERVED_MARKER = "reserved";

export interface DeadRun {
  /** The dead run's 7-char commit prefix — the `.ci/<sha7>` directory's
   *  name — or `""` when no directory names it (killed before the run's
   *  identity was stamped; only the lock/socket residue can speak). */
  sha7: string;
  /** The reserved run ordinal, when the reservation names one. */
  seq: number | null;
  /** The newest mtime among the residue (epoch ms) — the run's last sign of
   *  life. The death itself is untimed: a kill writes nothing. */
  lastActivityAt: number | null;
  /** Which residue the answer stands on. */
  evidence: {
    /** `.ci/odu.run.lock` exists and its PID is dead or unreadable. */
    lock: boolean;
    /** `.ci/odu.sock` exists and nobody answers it. */
    socket: boolean;
    /** A reservation sentinel that never became a record. */
    reservation: boolean;
  };
}

/** Paths a caller may pin (the run tool knows its own); the default derives
 *  the pair from the checkout root the way the run's own writers do. */
export interface DeadRunPaths {
  socketPath?: string;
  lockPath?: string;
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** PID of a live process holding `lockPath`, or `null` if the file is
 *  missing, unreadable, or names a dead/foreign process — odu's
 *  `liveRunLockPid` rule (signal-0; ESRCH and EPERM both read as "not a
 *  live coordinator"). */
function liveLockPid(lockPath: string): number | null {
  let pid: number | null = null;
  try {
    const parsed = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    pid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
  if (pid === null) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** The newest mtime in `dir`'s whole subtree — the last write a now-dead
 *  lane made. Missing pieces stat to null and drop out. */
function lastWriteUnder(dir: string): number | null {
  let best: number | null = null;
  const note = (t: number | null): void => {
    if (t !== null && (best === null || t > best)) best = t;
  };
  const walk = (path: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(path);
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry);
      let isDir = false;
      try {
        isDir = statSync(child).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(child);
      else note(mtimeOf(child));
    }
  };
  walk(dir);
  return best;
}

/** The newest reservation sentinel across `.ci/<sha7>/runs/` — an unfinished
 *  run, named. The walk is the ledger's own (every child directory, every
 *  `<seq>.json`), forgiving the same way: a file that won't parse skipped,
 *  never thrown. */
function newestReservation(ciDir: string): {
  sha7: string;
  seq: number;
  mtime: number | null;
} | null {
  let answer: { sha7: string; seq: number; mtime: number | null } | null =
    null;
  let children: string[];
  try {
    children = readdirSync(join(ciDir), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return null;
  }
  for (const sha7 of children) {
    let entries: string[];
    try {
      entries = readdirSync(join(ciDir, sha7, "runs"));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const path = join(ciDir, sha7, "runs", entry);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        continue;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as Record<string, unknown>)[RESERVED_MARKER] !== true
      ) {
        continue;
      }
      const seq = (parsed as Record<string, unknown>).seq;
      const mtime = mtimeOf(path);
      if (
        answer === null ||
        ((mtime ?? 0) > (answer.mtime ?? 0))
      ) {
        answer = { sha7, seq: typeof seq === "number" ? seq : 0, mtime };
      }
    }
  }
  return answer;
}

/**
 * Did a run DIE in this checkout — residue present, no live coordinator —
 * and what does it answer for? `null` is the steady state: a healthy run is
 * live, or nothing (recently) ran here at all.
 *
 * The socket probe IS a dial (there is no cheaper truth), so a caller that
 * just got `null` from its own {@link dialRun} pays one more connect on a
 * path that usually does not exist — the same economics the package's dial
 * already states for polling faces.
 */
export async function deadRun(
  checkoutRoot: string,
  paths: DeadRunPaths = {},
): Promise<DeadRun | null> {
  const socketPath = paths.socketPath ?? runSocketPath(checkoutRoot);
  const ciDir = dirname(socketPath);
  const lockPath = paths.lockPath ?? join(ciDir, RUN_LOCK_NAME);

  // 1. Something live wins. A serving socket first; then a live lock-holder
  //    (a run in its startup window serves no socket yet).
  //
  //    A dial that THROWS (dialRun's non-absence failures — e.g. ENOTSOCK on
  //    a junk file the kill left at the socket path) is NOT "a live run
  //    answered": treat it as not-serving and let the residue below carry
  //    the story. A face reading a death must never die of the death.
  const dialed = await dialRun(socketPath).catch(() => null);
  if (dialed !== null) {
    await dialed.close();
    return null;
  }
  if (liveLockPid(lockPath) !== null) return null;

  // 2. Residue is news.
  const lock = existsSync(lockPath);
  const socket = existsSync(socketPath);
  const reservation = newestReservation(ciDir);
  if (!lock && !socket && reservation === null) return null;

  const lastActivityAt = [mtimeOf(lockPath), mtimeOf(socketPath)].reduce<
    number | null
  >(
    (best, t) => (t !== null && (best === null || t > best) ? t : best),
    reservation === null
      ? null
      : [reservation.mtime, lastWriteUnder(join(ciDir, reservation.sha7))]
          .reduce<number | null>(
            (best, t) =>
              t !== null && (best === null || t > best) ? t : best,
            null,
          ),
  );

  return {
    sha7: reservation?.sha7 ?? "",
    seq: reservation?.seq ?? null,
    lastActivityAt,
    evidence: { lock, socket, reservation: reservation !== null },
  };
}

/** The one sentence every face answers with — so a chip, a wait's refusal
 *  and a ledger listing can never spell the same death two ways. Faces add
 *  their own next step (start a new run, read the logs); this only names
 *  the death, as far as the files can. */
export function describeDeadRun(dead: DeadRun): string {
  const ref =
    dead.sha7 === ""
      ? ""
      : ` ${dead.sha7}${dead.seq === null ? "" : `#${dead.seq}`}`;
  const died =
    dead.sha7 === "" ? "A run in this checkout died" : `The run${ref} died`;
  const residue: string[] = [];
  if (dead.evidence.reservation) residue.push("its unfinalized reservation");
  if (dead.evidence.lock) residue.push("its run lock");
  if (dead.evidence.socket) residue.push("its socket");
  const files =
    residue.length === 0
      ? ""
      : ` — ${residue.join(", ")} ${residue.length === 1 ? "is" : "are"} still in \`.ci\``;
  const when =
    dead.lastActivityAt === null
      ? ""
      : ` (last sign of life ${new Date(dead.lastActivityAt).toISOString()})`;
  return (
    `${died} with the process that started it — the coordinator was killed ` +
    `before the run could settle${files}${when}. The run is not coming back.`
  );
}
