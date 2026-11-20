import { fanoutPools, loadHosts, shortHost } from "@odu/execution/coordinator/hosts";
import {
  acquireFromPool,
  localHolderId,
} from "@odu/execution/coordinator/lease";
import {
  removePlatformLease,
  upsertPlatformLease,
} from "@odu/execution/coordinator/leaseRecord";
import {
  laneRunnerDrvPath,
  requireBakedRunnerSource,
} from "@odu/execution/coordinator/runnerFlake";

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

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

  requireBakedRunnerSource();
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
      resolveDrvPath: laneRunnerDrvPath,
      onLine: (msg) => {
        log(msg);
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
