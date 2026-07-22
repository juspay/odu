/**
 * `odu hosts` — inventory snapshot: every configured machine and whether its
 * venue lock is free or held (and by whom). Probes each host with a non-blocking
 * flock over ssh; does not acquire.
 */

import { loadHosts, shortHost } from "../coordinator/hosts";
import {
  formatHolder,
  probeAllHosts,
  type ProbeResult,
} from "../coordinator/lease";

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

  const rows = await probeAllHosts(config.hosts);
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
