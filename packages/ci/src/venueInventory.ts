import {
  asHostSlot,
  type HostPool,
  hostsOverrideOf,
  loadHosts,
} from "@odu/execution/coordinator/hosts";
import {
  isMixedPool,
  probeAllHosts,
  type ProbeResult,
} from "@odu/execution/coordinator/lease";
import {
  laneRunnerDrvPath,
  requireBakedRunnerSource,
} from "@odu/execution/coordinator/runnerFlake";
import type { Caller } from "@odu/service/caller";
import type {
  VenueProbeOutcome,
  VenueRowFacts,
} from "@odu/service/ports";

const VENUE_STATE: Record<ProbeResult["state"], VenueRowFacts["state"]> = {
  free: "free",
  busy: "busy",
  local: "local",
  unreachable: "down",
};

function rowFacts(platform: string, probe: ProbeResult): VenueRowFacts {
  return {
    platform,
    host: probe.host,
    slot: probe.slot,
    slots: probe.slots,
    state: VENUE_STATE[probe.state],
    heldBy:
      probe.heldBy === null
        ? null
        : {
            holder: probe.heldBy.holder,
            run: probe.heldBy.run,
            sinceMs: probe.heldBy.sinceMs,
          },
    error: probe.state === "unreachable" ? probe.error : null,
  };
}

function slotKey(row: { platform: string; host: string; slot: number }): string {
  return `${row.platform}\u0000${row.host}\u0000${row.slot}`;
}

function pendingFacts(platform: string, entry: HostPool[number]): VenueRowFacts {
  const slot = asHostSlot(entry);
  return {
    platform,
    host: slot.host,
    slot: slot.slot,
    slots: slot.slots,
    state: "probing",
    heldBy: null,
    error: null,
  };
}

export async function venueInventory(request: {
  platforms: readonly string[];
  caller: Caller;
  onReading?: (partial: {
    source: string | null;
    warnings: readonly string[];
    rows: readonly VenueRowFacts[];
  }) => void;
}): Promise<VenueProbeOutcome> {
  const config = loadHosts(hostsOverrideOf(request.caller.hostsFile));
  const configured = Object.keys(config.hosts).sort();
  if (configured.length === 0) {
    return {
      ok: false,
      message:
        "odu: no hosts configured" +
        (config.source !== null
          ? ` (${config.source} has no platforms)`
          : " (no hosts file found)"),
    };
  }

  const asked = [...new Set(request.platforms)];
  const platforms =
    asked.length === 0 ? configured : asked.filter((p) => p in config.hosts);
  if (platforms.length === 0) {
    return {
      ok: false,
      message:
        `odu: no hosts configured for ${asked.join(", ")} — ` +
        `${config.source ?? "the hosts config"} declares ${configured.join(", ")}`,
    };
  }

  const warnings = asked
    .filter((platform) => !(platform in config.hosts))
    .map(
      (platform) =>
        `${config.source ?? "hosts config"} declares no "${platform}", so it` +
        " was not probed",
    );
  for (const platform of platforms.filter((p) =>
    isMixedPool(config.hosts[p] ?? []),
  )) {
    warnings.push(
      `${config.source ?? "hosts config"}: host pool for "${platform}" mixes` +
        " localhost with remote hosts — any run that leases" +
        ` ${platform} will refuse it (use a pure-local or pure-remote pool)`,
    );
  }

  const pools = Object.fromEntries(
    platforms.map((platform) => [platform, config.hosts[platform] ?? []]),
  );
  requireBakedRunnerSource();

  const pending = new Map<string, VenueRowFacts>(
    Object.entries(pools).flatMap(([platform, pool]) =>
      pool.map((entry) => {
        const facts = pendingFacts(platform, entry);
        return [slotKey(facts), facts] as const;
      }),
    ),
  );
  const publish = (): void =>
    request.onReading?.({ source: config.source, warnings, rows: [...pending.values()] });
  publish();

  const probed = await probeAllHosts(pools, {
    resolveDrvPath: laneRunnerDrvPath,
    onProbe: ({ platform, probe }) => {
      const facts = rowFacts(platform, probe);
      pending.set(slotKey(facts), facts);
      publish();
    },
  });
  return {
    ok: true,
    source: config.source,
    warnings,
    rows: probed.map(({ platform, probe }) => rowFacts(platform, probe)),
  };
}

