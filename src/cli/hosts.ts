/**
 * `odu hosts` — inventory snapshot: every configured machine and whether its
 * venue lock is free or held (and by whom). Dials odu-runner on each host
 * (surface-remote) and calls `lease.probe`; does not acquire.
 */

import { loadHosts, shortHost } from "../coordinator/hosts";
import {
  formatHolder,
  isMixedPool,
  probeAllHosts,
  type ProbeResult,
} from "../coordinator/lease";
import {
  resolveRunnerFlake,
  runnerDrvResolver,
} from "../coordinator/runnerFlake";

function stateLabel(probe: ProbeResult): string {
  return probe.state === "unreachable" ? "down" : probe.state;
}

function heldByColumn(probe: ProbeResult, nowMs: number): string {
  if (probe.state === "busy" && probe.heldBy !== null) {
    return formatHolder(probe.heldBy, nowMs);
  }
  return probe.state === "unreachable" ? probe.error : "";
}

export async function hostsCommand(): Promise<number> {
  const config = loadHosts();
  const platforms = Object.keys(config.hosts).sort();
  if (platforms.length === 0) {
    process.stderr.write(
      "odu: no hosts configured" +
        (config.source !== null
          ? ` (${config.source} has no platforms)\n`
          : " (no hosts file found)\n"),
    );
    return 1;
  }

  // A mixed pool is illegal at the lease seam, but refusing HERE would be the
  // juspay/odu#66 defect again: `odu hosts` never leases, so an illegal pool
  // for a platform you are not running is none of this command's business to
  // refuse. It IS this command's business to report — the inventory view is
  // where an operator diagnoses their hosts file, and before this warning the
  // rule's only messenger was a run that refused later.
  for (const platform of platforms) {
    const pool = config.hosts[platform] ?? [];
    if (!isMixedPool(pool)) continue;
    process.stderr.write(
      `odu: warning: ${config.source ?? "hosts config"}: host pool for "${platform}"` +
        " mixes localhost with remote hosts — any run that leases" +
        ` ${platform} will refuse it (use a pure-local or pure-remote pool)\n`,
    );
  }

  const runnerFlake = resolveRunnerFlake(process.env);
  const rows = await probeAllHosts(config.hosts, {
    resolveDrvPath: (platform) =>
      runnerDrvResolver(runnerFlake, platform),
  });
  const nowMs = Date.now();

  // Column widths from content.
  const hostW = Math.max(
    4,
    ...rows.map((r) => shortHost(r.probe.host).length),
  );
  const platW = Math.max(8, ...rows.map((r) => r.platform.length));
  const stateW = 5; // free/busy/local/down

  const header =
    `${"HOST".padEnd(hostW)}  ${"PLATFORM".padEnd(platW)}  ${"STATE".padEnd(stateW)}  HELD BY`;
  process.stdout.write(`${header}\n`);

  for (const { platform, probe } of rows) {
    const host = shortHost(probe.host).padEnd(hostW);
    const plat = platform.padEnd(platW);
    const state = stateLabel(probe).padEnd(stateW);
    const held = heldByColumn(probe, nowMs);
    process.stdout.write(
      held !== ""
        ? `${host}  ${plat}  ${state}  ${held}\n`
        : `${host}  ${plat}  ${state}\n`,
    );
  }
  return 0;
}
