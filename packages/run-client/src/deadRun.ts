/**
 * `@odu/run-client/deadRun` — the read a dead run never got: a `.ci` that
 * outlived its coordinator.
 *
 * Answers a {@link DeadRun} when residue (a lock file and/or a socket file
 * nobody serves) is present with no live coordinator, and `null` otherwise.
 * `lastActivityAt` is the newest mtime among that run's own residue; `sha7` is
 * `""` when no `.ci/<sha7>` directory names the run. Both probes are this
 * host's facts.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { dialRun, runSocketPath } from "./dial";

/** The lock file's name within `.ci`. */
export const RUN_LOCK_NAME = "odu.run.lock";

/** The reservation sentinel's marker: a run that reserved a seq but never
 *  finalized its record. */
const RESERVED_MARKER = "reserved";

export interface DeadRun {
  /** The dead run's 7-char commit prefix, or `""` when no directory names it. */
  sha7: string;
  /** The reserved run ordinal, when the reservation names one. */
  seq: number | null;
  /** The newest mtime among the residue (epoch ms). */
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

/** What a pid answers to signal 0: `live` (ours and running), `foreign`
 *  (EPERM — a process exists at that pid under another uid) or `dead`. */
export type PidLiveness = "live" | "foreign" | "dead";

export function pidLiveness(pid: number): PidLiveness {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM" ? "foreign" : "dead";
  }
}

/** The lock file's answer: the holder's `PidLiveness`, or `stale` (no live
 *  process proven) or `absent`. */
function lockHolder(lockPath: string): PidLiveness | "stale" | "absent" {
  let pid: number | null = null;
  try {
    const parsed = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    pid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return "absent";
  }
  if (pid === null) return "stale";
  const liveness = pidLiveness(pid);
  return liveness === "dead" ? "stale" : liveness;
}

/** The newest reservation sentinel across `.ci/<sha7>/runs/` — an unfinished
 *  run, named. */
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
 * Did a run DIE in this checkout — residue present, no live coordinator — and
 * what does it answer for? `null` is the steady state. The socket probe IS a
 * dial.
 */
export async function deadRun(
  checkoutRoot: string,
  paths: DeadRunPaths = {},
): Promise<DeadRun | null> {
  const socketPath = paths.socketPath ?? runSocketPath(checkoutRoot);
  const ciDir = dirname(socketPath);
  const lockPath = paths.lockPath ?? join(ciDir, RUN_LOCK_NAME);

  const dialed = await dialRun(socketPath).catch(() => null);
  if (dialed !== null) {
    await dialed.close();
    return null;
  }
  const holder = lockHolder(lockPath);
  if (holder === "live" || holder === "foreign") return null;

  const lock = holder === "stale";
  const socket = existsSync(socketPath);
  if (!lock && !socket) return null;
  const reservation = newestReservation(ciDir);

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

/** The one sentence every face answers with. */
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
