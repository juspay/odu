/**
 * THE VENUES, TAKEN AND DROPPED — the engine half of `odu lease` / `odu
 * release`, on the daemon's side of the wall.
 *
 * `odu lease` and `odu release` are clients of the shared service now, so the
 * work they used to do in whatever process the operator typed in belongs to the
 * daemon: resolving a platform set against the CALLER's inventory, spawning a
 * detached holder, and answering as soon as each holder is running.
 *
 * `lease-hold` itself — the detached worker a holder IS — stayed in `@odu/cli`
 * beside the other argv entry points (`./leaseCmd`), because it is a process a
 * launcher types and never a library anybody calls.
 */

import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fanoutPools, loadHosts, shortHost } from "@odu/execution/coordinator/hosts";
import { formatHolder, type HolderInfo } from "@odu/execution/coordinator/lease";
import {
  heldHostForPlatform,
  pidAlive,
  readLeaseRecord,
  reconcileLeaseRecord,
  removePlatformLease,
  upsertPlatformLease,
} from "@odu/execution/coordinator/leaseRecord";
import { oduSelfArgv } from "@odu/execution/coordinator/spawn";
import type { Caller } from "@odu/service/caller";
import type {
  VenueHoldOutcome,
  VenueHoldResult,
  VenueReleaseResult,
} from "@odu/service/ports";

function asyncSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnLeaseHold(opts: {
  platform: string;
  noWait: boolean;
  repoRoot: string;
  hostsFile?: string | null;
}): number {
  const argv = [
    ...oduSelfArgv(),
    "lease-hold",
    "--platform",
    opts.platform,
    "--repo",
    opts.repoRoot,
  ];
  if (opts.noWait) argv.push("--no-wait");

  mkdirSync(join(opts.repoRoot, ".ci"), { recursive: true });
  const logPath = join(
    opts.repoRoot,
    ".ci",
    `lease-hold-${opts.platform}.log`,
  );
  let logFd: number;
  try {
    logFd = openSync(logPath, "a");
  } catch {
    logFd = openSync("/dev/null", "w");
  }

  const child = spawn(argv[0]!, argv.slice(1), {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    // The CALLER's inventory, carried to the holder. A hold outlives the shell
    // that asked for it and resolves its own pool, so a holder started from a
    // service whose `$ODU_HOSTS` differs from the caller's would queue for a
    // machine in a fleet the caller never named.
    env:
      opts.hostsFile === undefined || opts.hostsFile === null
        ? process.env
        : { ...process.env, ODU_HOSTS: opts.hostsFile },
    cwd: opts.repoRoot,
  });
  child.unref();
  if (child.pid === undefined) {
    throw new Error(`odu: failed to spawn lease-hold for ${opts.platform}`);
  }
  return child.pid;
}

function resolvePlatforms(
  requested: readonly string[],
  hostsFile: string | null,
): string[] {
  const hostsConfig = loadHosts(hostsFile ?? undefined);
  const pools = fanoutPools(
    hostsConfig,
    [],
    requested.length > 0 ? requested : [],
  );
  const all = Object.keys(pools.hosts).sort();
  if (requested.length === 0) {
    if (all.length === 0) {
      throw new Error("odu: no platforms to lease (configure hosts.json)");
    }
    return all;
  }
  for (const p of requested) {
    if (pools.hosts[p] === undefined) {
      throw new Error(
        `odu: platform "${p}" is not in hosts config ` +
          `(have: ${all.join(", ") || "none"})`,
      );
    }
  }
  return [...requested].sort();
}

/** A holder's identity as the port spells it. Structurally `HolderInfo`,
 *  written out so the compiler proves the two spellings are one shape here,
 *  where both are in scope. */
function holderFacts(
  info: HolderInfo | null,
): VenueHoldResult["waitingBehind"] {
  return info === null
    ? null
    : { holder: info.holder, run: info.run, sinceMs: info.sinceMs };
}

export interface LeaseOptions {
  platforms: readonly string[];
  /** WHO the hold is for. Resolved here, in the service's process, whose own
   *  environment is a fact about the shell that started it. See {@link Caller}. */
  caller: Caller;
  /** Try once and let the holder exit rather than queueing. The HOLDER's
   *  persistence, not this call's — this call never waits either way. */
  noWait: boolean;
  repoRoot?: string;
}

/**
 * Ensure platforms are leased, spawning holders as needed.
 *
 * It ANSWERS AS SOON AS EACH HOLDER IS RUNNING and never polls for the box.
 * `odu lease` used to block, printing progress, because it was a terminal
 * command with a person watching it; through the service the queue it joins is
 * somebody else's run and can be an hour long, so `waiting` — with
 * `waitingBehind` naming who is ahead — is the complete answer, and
 * `venue.probe` is where a caller watches it land.
 *
 * A platform set that resolves to nothing — no hosts config, or a name that is
 * not in one — is a REFUSAL and not an empty result list, for the reason
 * `VenueProbeOutcome` gives: "nothing is configured" and "nothing was free"
 * call for opposite actions.
 */
export async function leaseVenues(
  opts: LeaseOptions,
): Promise<VenueHoldOutcome> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  let platforms: string[];
  try {
    platforms = resolvePlatforms(opts.platforms, opts.caller.hostsFile);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
  reconcileLeaseRecord(repoRoot);
  const results: VenueHoldResult[] = [];

  for (const platform of platforms) {
    const existing = heldHostForPlatform(repoRoot, platform);
    if (existing !== null) {
      const rec = readLeaseRecord(repoRoot)[platform];
      results.push({
        platform,
        status: "already",
        host: existing,
        holderPid: rec?.holderPid ?? null,
        waitingBehind: null,
        message: `${platform}: already held ${shortHost(existing)} (pid ${rec?.holderPid ?? "?"})`,
      });
      continue;
    }

    const rec = readLeaseRecord(repoRoot)[platform];
    if (
      rec !== undefined &&
      rec.state === "waiting" &&
      pidAlive(rec.holderPid)
    ) {
      results.push({
        platform,
        status: "waiting",
        host: null,
        holderPid: rec.holderPid,
        waitingBehind: holderFacts(rec.waitingBehind),
        message: waitingMessage(platform, rec.waitingBehind),
      });
      continue;
    }

    const pid = spawnLeaseHold({
      platform,
      noWait: opts.noWait,
      repoRoot,
      hostsFile: opts.caller.hostsFile,
    });
    upsertPlatformLease(repoRoot, platform, {
      host: null,
      holderPid: pid,
      since: Date.now(),
      state: "waiting",
      waitingBehind: null,
      run: null,
    });

    // A short grace, because a FREE box is claimed almost immediately and
    // answering `waiting` for one that is already ours would send every caller
    // round the polling loop for nothing. `--no-wait` gets longer: it is the
    // caller who said "tell me now whether this worked", and its holder exits
    // rather than queueing, so this window is the only chance to see it.
    await asyncSleep(opts.noWait ? 400 : 150);
    const held = heldHostForPlatform(repoRoot, platform);
    if (held !== null) {
      results.push({
        platform,
        status: "held",
        host: held,
        holderPid: pid,
        waitingBehind: null,
        message: `${platform}: held ${shortHost(held)} (pid ${pid})`,
      });
      continue;
    }
    const r = readLeaseRecord(repoRoot)[platform];
    results.push({
      platform,
      status: "waiting",
      host: null,
      holderPid: pid,
      waitingBehind: holderFacts(r?.waitingBehind ?? null),
      message: opts.noWait
        ? `${platform}: every host busy (or hold failed) — see .ci/lease-hold-${platform}.log`
        : waitingMessage(platform, r?.waitingBehind ?? null),
    });
  }

  return { ok: true, results };
}

function waitingMessage(
  platform: string,
  behind: HolderInfo | null,
): string {
  if (behind !== null) {
    return `${platform}: waiting — behind ${formatHolder(behind)}`;
  }
  return `${platform}: waiting — queueing for a free host`;
}

/**
 * Drop this checkout's holds.
 *
 * There is no refusal arm. Releasing what is not held is not an error — it is
 * the outcome `nothing`, and saying so is what makes `odu release` safe to run
 * twice, which is exactly what a caller who lost the first reply will do.
 */
export function releaseVenues(opts: {
  platforms: readonly string[];
  repoRoot?: string;
}): { results: readonly VenueReleaseResult[] } {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const { record } = reconcileLeaseRecord(repoRoot);
  const platforms =
    opts.platforms.length > 0 ? opts.platforms : Object.keys(record).sort();

  const results: VenueReleaseResult[] = [];
  for (const platform of platforms) {
    const e = record[platform] ?? readLeaseRecord(repoRoot)[platform];
    if (e === undefined) {
      results.push({
        platform,
        effective: "nothing",
        host: null,
        detail: `no lease record for ${platform} in this checkout`,
      });
      continue;
    }
    if (!pidAlive(e.holderPid)) {
      // The record outlived its holder. Nothing was released because nothing
      // was holding — but the stale record still goes, below.
      results.push({
        platform,
        effective: "nothing",
        host: e.host,
        detail: `holder pid ${e.holderPid} was already gone`,
      });
    } else {
      try {
        process.kill(e.holderPid, "SIGTERM");
        results.push({
          platform,
          effective: "released",
          host: e.host,
          detail: `signalled holder pid ${e.holderPid}`,
        });
      } catch (err) {
        results.push({
          platform,
          effective: "nothing",
          host: e.host,
          detail: `could not signal pid ${e.holderPid}: ${(err as Error).message}`,
        });
      }
    }
    // Holder cleans the record on SIGTERM; always drop our side so release
    // is idempotent even if the holder was already gone.
    removePlatformLease(repoRoot, platform);
  }
  return { results };
}
