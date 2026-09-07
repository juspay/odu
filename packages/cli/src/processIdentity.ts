/**
 * START-QUALIFIED PROCESS IDENTITY — the pair the singleton gate compares.
 *
 * `@kolu/surface-daemon`'s pid gate does not ask "is there a process with that
 * number", because the number is reused: a machine that reboots and hands pid
 * 4211 to something else would strand a daemon that could never start again. It
 * asks whether the process at that pid is THE SAME process, by pid AND start
 * time, and it takes both as an injected reader so the spine never has to know
 * how a platform answers.
 *
 * kolu's own daemons inject `osfacts-client`'s reader, which shells out to a
 * baked `osfacts` binary. odu does not ship one — its flake takes exactly one
 * input by policy (see `flake.nix`), and baking a Rust binary for one fact is a
 * build dependency out of proportion to it. So this module answers the same
 * question from what each platform already exposes.
 *
 * **The failure mode is the whole design.** `undefined` means "that process is
 * GONE", and the gate treats it as licence to reclaim a stale gate file. If a
 * reader answered `undefined` merely because it could not READ, a live
 * singleton's gate would be stolen out from under it and two daemons would
 * serve one home. So the two answers are kept apart by asking a second,
 * independent question first — `kill(pid, 0)`, which needs no parsing and no
 * platform knowledge:
 *
 *   - the process is gone            → `undefined`, and the gate may reclaim;
 *   - it is alive and readable       → its identity;
 *   - it is alive and UNREADABLE     → **throw**, and the daemon refuses to
 *     start rather than taking a gate it cannot prove is free.
 *
 * Fail-closed, and on an unsupported platform the refusal names itself instead
 * of two daemons quietly racing.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** The pair the gate records and compares — structurally
 *  `@kolu/surface-daemon`'s `ProcessIdentity`, spelled here so this module
 *  imports nothing to state its own answer. */
export interface ProcessIdentity {
  pid: number;
  startUnixUs: number;
}

/**
 * Is this pid a live process we may signal?
 *
 * `EPERM` is ALIVE: a process we are not allowed to signal is still a process,
 * and reading a permission error as death is how a gate held by another user's
 * daemon gets reclaimed.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * USER_HZ — the unit `/proc/<pid>/stat`'s start time is counted in.
 *
 * 100 on every Linux ABI in practice, and there is no `sysconf` from Node to
 * ask. It only has to be right to within the gate's own ±2s tolerance, and a
 * wrong HZ would be off by a factor rather than by a second — which is exactly
 * why the comparison below is anchored to boot time and cross-checked against
 * the tolerance rather than trusted blind.
 */
const USER_HZ = 100;

/** Boot time in unix seconds, from `/proc/stat`'s `btime` line. */
function bootUnixSeconds(): number {
  const stat = readFileSync("/proc/stat", "utf-8");
  const line = stat.split("\n").find((l) => l.startsWith("btime "));
  if (line === undefined) throw new Error("/proc/stat has no btime line");
  const value = Number(line.slice("btime ".length).trim());
  if (!Number.isFinite(value)) throw new Error("/proc/stat btime is not a number");
  return value;
}

/**
 * `/proc/<pid>/stat` field 22, in microseconds since the epoch.
 *
 * The comm field (2) is parenthesised and may itself contain spaces and
 * parentheses — `(my (weird) proc)` is a legal process name — so the fields
 * after it are counted from the LAST `)` rather than by splitting the whole
 * line. Splitting naively is the classic way to read the wrong field for one
 * process in a thousand, and the wrong field here is a wrong identity.
 */
function linuxStartUnixUs(pid: number): number {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf-8");
  const close = raw.lastIndexOf(")");
  if (close < 0) throw new Error(`/proc/${pid}/stat is not in the expected shape`);
  // Field 3 (state) onwards, so field 22 is index 19 here.
  const rest = raw.slice(close + 2).trim().split(/\s+/);
  const ticks = Number(rest[19]);
  if (!Number.isFinite(ticks)) {
    throw new Error(`/proc/${pid}/stat has no readable start time`);
  }
  return Math.round((bootUnixSeconds() + ticks / USER_HZ) * 1_000_000);
}

/**
 * macOS: `ps -o lstart=`, at one-second resolution.
 *
 * Coarser than Linux's, and that is fine: the gate compares with a ±2s
 * tolerance precisely because a start time is a reading rather than a serial
 * number. What it buys is the property that matters — a pid reused after a
 * reboot has a start time on the other side of that reboot.
 */
function darwinStartUnixUs(pid: number): number {
  const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const at = Date.parse(out);
  if (!Number.isFinite(at)) {
    throw new Error(`ps reported an unparseable start time for ${pid}: ${out}`);
  }
  return at * 1000;
}

function startUnixUs(pid: number): number {
  if (process.platform === "linux") return linuxStartUnixUs(pid);
  if (process.platform === "darwin") return darwinStartUnixUs(pid);
  throw new Error(
    `odu: no way to read a process start time on ${process.platform} — the ` +
      "web service's singleton gate needs one to tell a live daemon from a " +
      "reused pid",
  );
}

/** This process's own identity, for the gate it is about to claim. */
export function selfProcessIdentity(): ProcessIdentity {
  return { pid: process.pid, startUnixUs: startUnixUs(process.pid) };
}

/**
 * Another process's identity, or `undefined` when it is gone.
 *
 * The two questions in the order that keeps them apart — see the module header.
 * A process that is alive but unreadable THROWS, so a gate is never reclaimed
 * on the strength of a read that failed.
 */
export function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (!alive(pid)) return undefined;
  try {
    return { pid, startUnixUs: startUnixUs(pid) };
  } catch (err) {
    // Between the liveness check and the read the process may genuinely have
    // exited, and on Linux that is exactly an ENOENT on its `/proc` entry.
    // That IS the gone answer; anything else is a read we could not make.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `odu: pid ${pid} is alive but its start time could not be read ` +
        `(${(err as Error).message}) — refusing to treat its gate as free`,
    );
  }
}
