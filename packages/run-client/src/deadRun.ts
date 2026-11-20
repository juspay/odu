/**
 * `@odu/run-client/deadRun` — the read a dead run never got: a `.ci` that
 * outlived its coordinator.
 *
 * `dialRun` answers `null` both when no run ever ran here and when a run WAS
 * here and its coordinator was killed before it could settle. The difference
 * is visible on disk, because a clean exit removes the residue a kill cannot.
 * The checks, in order:
 *
 *   1. SOMETHING LIVE WINS. A socket that answers, or a run lock whose PID
 *      answers signal-0 — including with EPERM — means a coordinator owns
 *      this checkout, so answer `null`.
 *   2. RESIDUE IS NEWS — a LOCK FILE and/or a SOCKET FILE nobody serves is
 *      the corpse. A `.ci/<sha7>/runs/<seq>.json` carrying the `reserved`
 *      sentinel NAMES the dead run but never proves one: it stays on disk as
 *      history after a recovery removed lock and socket.
 *
 * What it cannot say:
 *
 *   - the death is never timestamped, so `lastActivityAt` is the newest mtime
 *     among the DEAD RUN'S OWN residue — the lock, the socket, the sentinel,
 *     and the per-seq tee (`.ci/<sha7>/runs/<seq>.log`). The commit-addressed
 *     node logs are NOT consulted: a later run of the same commit writes
 *     those very paths;
 *   - a run killed before it stamped `.ci/<sha7>` has `sha7` `""` and claims
 *     no commit;
 *   - both probes are THIS HOST'S facts: a coordinator live on another
 *     machine whose `.ci` is a network mount reads like the incident here.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { dialRun, runSocketPath } from "./dial";

/** The lock file's name within `.ci` — the spelling is the layout contract
 *  between its writer and every reader, the way `SOCKET_PATH` is for the
 *  socket. */
export const RUN_LOCK_NAME = "odu.run.lock";

/** The reservation sentinel's marker: a run that reserved a seq but never
 *  finalized its record. Read here by marker alone, never parsed into a
 *  record. */
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

/** Paths a caller may pin; the default derives the pair from the checkout
 *  root. */
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

/** The lock file's answer, for THIS question. EPERM means a process at that
 *  pid EXISTS and we may not signal it — that answer must veto a corpse
 *  reading, or a live-but-foreign coordinator is mistaken for a dead one.
 *
 * `stale`: the file is here but no live process is proven — ESRCH, or
 *  contents no pid parses out of. */
function lockHolder(lockPath: string): "live" | "foreign" | "stale" | "absent" {
  let pid: number | null = null;
  try {
    const parsed = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    pid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return "absent";
  }
  if (pid === null) return "stale";
  try {
    process.kill(pid, 0);
    return "live";
  } catch (err) {
    // EPERM: the pid is alive under another uid — never declare its death.
    if ((err as NodeJS.ErrnoException).code === "EPERM") return "foreign";
    return "stale";
  }
}

/** The newest reservation sentinel across `.ci/<sha7>/runs/` — an unfinished
 *  run, named. A file that won't parse is skipped, never thrown. */
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
 * The socket probe IS a dial, so a caller that just got `null` from its own
 * {@link dialRun} pays one more connect.
 */
export async function deadRun(
  checkoutRoot: string,
  paths: DeadRunPaths = {},
): Promise<DeadRun | null> {
  const socketPath = paths.socketPath ?? runSocketPath(checkoutRoot);
  const ciDir = dirname(socketPath);
  const lockPath = paths.lockPath ?? join(ciDir, RUN_LOCK_NAME);

  // A dial that THROWS is not "a live run answered": treat it as not-serving
  // and let the residue below carry the story.
  const dialed = await dialRun(socketPath).catch(() => null);
  if (dialed !== null) {
    await dialed.close();
    return null;
  }
  const holder = lockHolder(lockPath);
  if (holder === "live" || holder === "foreign") return null;

  // The corpse trigger is the lock and/or the socket. The sentinel NAMES the
  // corpse when one exists; it is never the trigger.
  const lock = holder === "stale";
  const socket = existsSync(socketPath);
  if (!lock && !socket) return null;
  const reservation = newestReservation(ciDir);

  // The `<sha7>/<platform>/<node>.log` paths are addressed by COMMIT, so a
  // later run of the same sha writes them: a dead seq must never be
  // timestamped with a live seq's writes.
  const perSeq: Array<number | null> =
    reservation === null
      ? []
      : [
          reservation.mtime,
          mtimeOf(join(ciDir, reservation.sha7, "runs", `${reservation.seq}.log`)),
        ];
  const lastActivityAt = [mtimeOf(lockPath), mtimeOf(socketPath), ...perSeq]
    .reduce<number | null>(
      (best, t) => (t !== null && (best === null || t > best) ? t : best),
      null,
    );

  return {
    sha7: reservation?.sha7 ?? "",
    seq: reservation?.seq ?? null,
    lastActivityAt,
    evidence: { lock, socket, reservation: reservation !== null },
  };
}

/** The one sentence every face answers with — so a chip, a wait's refusal
 *  and a ledger listing can never spell the same death two ways. */
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
