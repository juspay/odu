/**
 * Agent-held venue leases: `odu lease` / `odu release` / hidden `odu lease-hold`.
 *
 * Terminal agents with no orchestrator call `odu lease` once, then iterate
 * `odu run` → fix → run without re-queuing (run consumes the held host and
 * does not release on exit). Release is explicit (`odu release` / SIGTERM on
 * the holder).
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
  liveHeldPlatforms,
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
import { oduSelfArgv } from "./mcp/runTool";

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function out(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

function asyncSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Spawn detached holder; returns child pid. */
export function spawnLeaseHold(opts: {
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

export interface LeaseCliResult {
  platform: string;
  status: "held" | "waiting" | "already";
  host: string | null;
  holderPid?: number;
  waitingBehind?: HolderInfo | null;
  message: string;
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

/**
 * Ensure platforms are leased (spawn holders as needed).
 * `nonBlocking` (MCP): return immediately after spawn with held/waiting.
 * CLI default: poll until held (or noWait fail).
 */
export async function leaseCommand(opts: {
  platforms: readonly string[];
  noWait: boolean;
  repoRoot?: string;
  nonBlocking: boolean;
}): Promise<{ code: number; results: LeaseCliResult[] }> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const platforms = resolvePlatforms(opts.platforms);
  reconcileLeaseRecord(repoRoot);
  const results: LeaseCliResult[] = [];

  for (const platform of platforms) {
    const existing = heldHostForPlatform(repoRoot, platform);
    if (existing !== null) {
      const rec = readLeaseRecord(repoRoot)[platform];
      results.push({
        platform,
        status: "already",
        host: existing,
        holderPid: rec?.holderPid,
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
        waitingBehind: rec.waitingBehind,
        message: waitingMessage(platform, rec.waitingBehind),
      });
      if (!opts.nonBlocking && !opts.noWait) {
        const r = await waitForHolder(repoRoot, platform, rec.holderPid);
        results[results.length - 1] = r;
      }
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

    if (opts.nonBlocking) {
      await asyncSleep(opts.noWait ? 400 : 150);
      const held = heldHostForPlatform(repoRoot, platform);
      if (held !== null) {
        results.push({
          platform,
          status: "held",
          host: held,
          holderPid: pid,
          message: `${platform}: held ${shortHost(held)} (pid ${pid})`,
        });
      } else {
        const r = readLeaseRecord(repoRoot)[platform];
        results.push({
          platform,
          status: "waiting",
          host: null,
          holderPid: pid,
          waitingBehind: r?.waitingBehind ?? null,
          message: waitingMessage(platform, r?.waitingBehind ?? null),
        });
      }
      continue;
    }

    if (opts.noWait) {
      await asyncSleep(500);
      const held = heldHostForPlatform(repoRoot, platform);
      if (held !== null) {
        results.push({
          platform,
          status: "held",
          host: held,
          holderPid: pid,
          message: `${platform}: held ${shortHost(held)} (pid ${pid})`,
        });
      } else {
        results.push({
          platform,
          status: "waiting",
          host: null,
          holderPid: pid,
          message: `${platform}: every host busy (or hold failed) — see .ci/lease-hold-${platform}.log`,
        });
      }
      continue;
    }

    results.push(await waitForHolder(repoRoot, platform, pid));
  }

  for (const r of results) out(r.message);
  const allOk = results.every(
    (r) => r.status === "held" || r.status === "already",
  );
  return { code: allOk ? 0 : 1, results };
}

async function waitForHolder(
  repoRoot: string,
  platform: string,
  pid: number,
): Promise<LeaseCliResult> {
  let lastMsg = "";
  for (;;) {
    if (!pidAlive(pid)) {
      const held = heldHostForPlatform(repoRoot, platform);
      if (held !== null) {
        return {
          platform,
          status: "held",
          host: held,
          message: `${platform}: held ${shortHost(held)}`,
        };
      }
      return {
        platform,
        status: "waiting",
        host: null,
        message: `${platform}: lease-hold exited without hold — see .ci/lease-hold-${platform}.log`,
      };
    }
    const r = readLeaseRecord(repoRoot)[platform];
    if (r?.state === "held" && r.host !== null) {
      const msg = `${platform}: held ${shortHost(r.host)} (pid ${pid})`;
      if (msg !== lastMsg) log(msg);
      return {
        platform,
        status: "held",
        host: r.host,
        holderPid: pid,
        message: msg,
      };
    }
    const msg = waitingMessage(platform, r?.waitingBehind ?? null);
    if (msg !== lastMsg) {
      log(msg);
      lastMsg = msg;
    }
    await asyncSleep(2_000);
  }
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

export function releaseCommand(opts: {
  platforms: readonly string[];
  repoRoot?: string;
}): number {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const { record } = reconcileLeaseRecord(repoRoot);
  const platforms =
    opts.platforms.length > 0
      ? opts.platforms
      : Object.keys(record).sort();

  if (platforms.length === 0) {
    log("odu: no agent-held leases in this checkout");
    return 0;
  }

  let code = 0;
  for (const platform of platforms) {
    const e = record[platform] ?? readLeaseRecord(repoRoot)[platform];
    if (e === undefined) {
      log(`odu: no lease record for ${platform}`);
      code = 1;
      continue;
    }
    if (pidAlive(e.holderPid)) {
      try {
        process.kill(e.holderPid, "SIGTERM");
        log(
          `odu: signalled holder pid ${e.holderPid} for ${platform}` +
            (e.host !== null ? ` (${shortHost(e.host)})` : ""),
        );
      } catch (err) {
        log(
          `odu: could not signal pid ${e.holderPid}: ${(err as Error).message}`,
        );
        code = 1;
      }
    } else {
      log(`odu: holder pid ${e.holderPid} for ${platform} already dead`);
    }
    // Holder cleans the record on SIGTERM; always drop our side so release
    // is idempotent even if the holder was already gone.
    removePlatformLease(repoRoot, platform);
  }
  return code;
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

export function agentHeldLines(repoRoot: string): string[] {
  return Object.entries(liveHeldPlatforms(repoRoot)).map(
    ([p, h]) => `${p}: agent-held ${shortHost(h)}`,
  );
}
