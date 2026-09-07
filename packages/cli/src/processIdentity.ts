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
 * That reader is `osfacts`, the same one kolu's own daemons inject.
 *
 * ## What this file used to be, and why it is not that any more
 *
 * It used to answer the question itself: 161 lines that parsed
 * `/proc/<pid>/stat` field 22 against a hardcoded `USER_HZ = 100`, added
 * `/proc/stat`'s `btime`, and on macOS shelled out to `ps -o lstart=` and
 * `Date.parse`d a locale-formatted string at one-second resolution. Its header
 * justified all of that by claiming odu could not ship the osfacts binary
 * without a flake input its policy forbids.
 *
 * The claim was false. `npins/sources.json` already pinned `juspay/osfacts` —
 * odu grafts `osfacts-client` out of that very pin — and the pin's own
 * `default.nix` takes `{ pkgs }`, so composing the binary is one attribute in
 * `nix/overlay.nix` and one `--set ODU_OSFACTS_BIN` on the wrapper. No input,
 * no policy exception, and none of the code below.
 *
 * The replacement is not merely equivalent, it is more correct on both
 * platforms: osfacts reads the real `sysconf(_SC_CLK_TCK)` where this file
 * assumed 100, and decodes `kinfo_proc` at microsecond resolution on Darwin
 * where this file parsed a human-readable clock string.
 *
 * ## The failure mode is still the whole design
 *
 * `undefined` means "that process is GONE", and the gate treats it as licence to
 * reclaim a stale gate file. A reader that answered `undefined` merely because
 * it could not READ would let a live singleton's gate be stolen out from under
 * it, and two daemons would serve one home. osfacts keeps exactly that
 * distinction — its start-time fold answers `undefined` only for `ESRCH` /
 * `ENOENT` and throws for anything else — so the policy this file used to
 * implement by hand is now the policy it inherits.
 */

import { isHolderLive, type ProcessIdentity } from "@kolu/surface-daemon";
import { processIdentityFromEnv } from "osfacts-client";

export type { ProcessIdentity };

/** The env var the Nix wrapper bakes the osfacts binary's absolute path into.
 *  There is no PATH fallback, here or in the client: a substituted `osfacts` is
 *  a wire-format the client would only discover it could not read at gate-claim
 *  time, which is the worst moment to find out. */
const OSFACTS_BIN_ENV = "ODU_OSFACTS_BIN";

/** This process's own identity, for the gate it is about to claim. */
export function selfProcessIdentity(): ProcessIdentity {
  const identity = processIdentityFromEnv(OSFACTS_BIN_ENV, process.pid);
  if (identity === undefined) {
    // Unreachable in practice and worth stating anyway: osfacts answered "that
    // pid is gone" about the process doing the asking. Claiming a gate on a
    // reading that self-contradictory is not something to do quietly.
    throw new Error(
      `odu: osfacts reports this process (pid ${process.pid}) as gone — ` +
        "refusing to claim the web service's gate on a reading that cannot " +
        "be true",
    );
  }
  return identity;
}

/**
 * Another process's identity, or `undefined` when it is gone.
 *
 * Two questions in the order that keeps them apart. `isHolderLive` — the
 * framework's own `kill(pid, 0)` probe, which needs no parsing and no platform
 * knowledge, and which reads `EPERM` as ALIVE because a process we may not
 * signal is still a process — answers the first. osfacts answers the second,
 * and a process that is alive but UNREADABLE throws rather than being reported
 * as gone, so a gate is never reclaimed on the strength of a read that failed.
 */
export function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (!isHolderLive(pid)) return undefined;
  try {
    return processIdentityFromEnv(OSFACTS_BIN_ENV, pid);
  } catch (err) {
    throw new Error(
      `odu: pid ${pid} is alive but its start time could not be read ` +
        `(${(err as Error).message}) — refusing to treat its gate as free`,
    );
  }
}
