/**
 * Agent-held venue leases: `odu lease` / `odu release` / hidden `odu lease-hold`.
 *
 * Terminal agents with no orchestrator call `odu lease` once, then iterate
 * `odu run` → fix → run without re-queuing (run consumes the held host and
 * does not release on exit). Release is explicit (`odu release` / SIGTERM on
 * the holder).
 *
 * Taking and dropping a hold now RETURN their results rather than printing
 * them: both are public commands, both are served through the shared service,
 * and a function whose only output was `process.stdout` could be called by
 * exactly one face. `leaseHoldCommand` is the exception and stays a process —
 * it IS the holder, an argv entry point a launcher types and a person never
 * does, and its output is a log file nobody reads unless a hold went wrong.
 */

import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fanoutPools, loadHosts, shortHost } from "@odu/execution/coordinator/hosts";
import {
  acquireFromPool,
  formatHolder,
  localHolderId,
  type HolderInfo,
} from "@odu/execution/coordinator/lease";
import {
  heldHostForPlatform,
  pidAlive,
  readLeaseRecord,
  reconcileLeaseRecord,
  removePlatformLease,
  upsertPlatformLease,
} from "@odu/execution/coordinator/leaseRecord";
import {
  resolveRunnerFlake,
  runnerDrvResolver,
} from "@odu/execution/coordinator/runnerFlake";
import { oduSelfArgv } from "@odu/execution/coordinator/spawn";
import type {
  VenueHoldOutcome,
  VenueHoldResult,
  VenueReleaseResult,
} from "@odu/service/ports";

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function asyncSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Spawn detached holder; returns child pid.
 *
 * **WHOSE CHILD THIS IS HAS CHANGED, and it is the point.** `odu lease` used to
 * fork this from the operator's own shell, which made a hold's lifetime a
 * property of which terminal took it — the one thing a hold was never supposed
 * to be, and the reason a browser or an agent could not take one at all.
 * Through the service the caller is the daemon, so this is the daemon's child.
 *
 * Three things that had to keep working, and why they do:
 *
 *   - `.ci/odu-lease.json` is unmoved and unchanged in format. The holder writes
 *     it from `--repo`, which is the CHECKOUT's root and not the caller's cwd,
 *     so a record taken through the daemon lands exactly where a record taken
 *     from a shell did. Nothing reads it by "the directory I was started in".
 *   - `holderPid` is now a pid in the daemon's process tree. `pidAlive` is
 *     `kill(pid, 0)`, which answers for any process the caller may signal — the
 *     daemon runs as the operator, so the operator's `odu release` still reaches
 *     it, and the holder still reaches it to clean up. Same machine, same uid;
 *     the only thing that changed is which parent reaped it.
 *   - `heldHostForPlatform`, which the COORDINATOR consults at run time to
 *     consume an agent's hold, reads that same file and calls that same
 *     `pidAlive`. The coordinator is itself launched by the daemon, so it is on
 *     the machine the holder is on — the invariant that check has always
 *     depended on, and one the service does not weaken.
 *
 * `detached: true` survives the parent either way, so a daemon restart does not
 * drop the holds it took — which is what "held across runs" was always supposed
 * to mean.
 */
function spawnLeaseHold(opts: {
  platform: string;
  noWait: boolean;
  repoRoot: string;
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
    env: process.env,
    cwd: opts.repoRoot,
  });
  child.unref();
  if (child.pid === undefined) {
    throw new Error(`odu: failed to spawn lease-hold for ${opts.platform}`);
  }
  return child.pid;
}

function resolvePlatforms(requested: readonly string[]): string[] {
  const hostsConfig = loadHosts();
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
    platforms = resolvePlatforms(opts.platforms);
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

/**
 * Detached holder entry: claim (wait or no-wait), update record, hold until
 * SIGTERM.
 */
export async function leaseHoldCommand(opts: {
  platform: string;
  noWait: boolean;
  repoRoot: string;
}): Promise<number> {
  const { platform, noWait, repoRoot } = opts;
  const hostsConfig = loadHosts();
  const pools = fanoutPools(hostsConfig, [], [platform]);
  const pool = pools.hosts[platform];
  if (pool === undefined || pool.length === 0) {
    log(`odu lease-hold: no pool for ${platform}`);
    removePlatformLease(repoRoot, platform);
    return 1;
  }

  const runnerFlake = resolveRunnerFlake(process.env);
  const pid = process.pid;

  upsertPlatformLease(repoRoot, platform, {
    host: null,
    holderPid: pid,
    since: Date.now(),
    state: "waiting",
    waitingBehind: null,
    run: null,
  });

  try {
    const acquired = await acquireFromPool({
      platform,
      pool,
      source: pools.source,
      identity: {
        holder: localHolderId(),
        run: `lease-hold:${pid}`,
      },
      noWait,
      resolveDrvPath: runnerDrvResolver(runnerFlake, platform),
      onLine: (msg) => {
        log(msg);
        // Keep waiting state visible while queueing.
        if (msg.includes("waiting")) {
          upsertPlatformLease(repoRoot, platform, {
            host: null,
            holderPid: pid,
            since: Date.now(),
            state: "waiting",
            waitingBehind: null,
            run: null,
          });
        }
      },
    });

    upsertPlatformLease(repoRoot, platform, {
      host: acquired.host,
      holderPid: pid,
      since: Date.now(),
      state: "held",
      waitingBehind: null,
      run: `lease-hold:${pid}`,
    });
    log(
      `odu lease-hold: held ${platform}=${shortHost(acquired.host)} (pid ${pid})`,
    );

    await new Promise<void>((resolve) => {
      const stop = (): void => {
        log(`odu lease-hold: releasing ${platform}`);
        acquired.lease?.release();
        removePlatformLease(repoRoot, platform);
        resolve();
      };
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    });
    return 0;
  } catch (e) {
    log(`odu lease-hold: ${platform}: ${(e as Error).message}`);
    removePlatformLease(repoRoot, platform);
    return 1;
  }
}

