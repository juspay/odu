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

const HOLD_SETTLE_MS = 150;
const NO_WAIT_SETTLE_MS = 400;

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

function holderFacts(
  info: HolderInfo | null,
): VenueHoldResult["waitingBehind"] {
  return info === null
    ? null
    : { holder: info.holder, run: info.run, sinceMs: info.sinceMs };
}

export interface LeaseOptions {
  platforms: readonly string[];
  caller: Caller;
  noWait: boolean;
  repoRoot?: string;
}

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

    await asyncSleep(opts.noWait ? NO_WAIT_SETTLE_MS : HOLD_SETTLE_MS);
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
    removePlatformLease(repoRoot, platform);
  }
  return { results };
}
