/**
 * THE INVENTORY behind `odu hosts` — every configured machine and whether its
 * venue lock is free or held (and by whom). Dials odu-runner on each host
 * (surface-remote) and calls `lease.probe`; does not acquire.
 *
 * It RETURNS the inventory rather than printing it, and that is the whole
 * change: `odu hosts` is a public command, so its answer comes from the shared
 * service, and a function whose only output was `process.stdout` could be
 * called by exactly one face. The table an operator reads is now rendered by
 * whichever face asked — `@odu/cli`'s terminal projection, or a browser.
 */

import { loadHosts } from "@odu/execution/coordinator/hosts";
import {
  isMixedPool,
  probeAllHosts,
  type ProbeResult,
} from "@odu/execution/coordinator/lease";
import {
  resolveRunnerFlake,
  runnerDrvResolver,
} from "@odu/execution/coordinator/runnerFlake";
import type { VenueProbeOutcome, VenueRowFacts } from "@odu/service/ports";

/**
 * The wire says `unreachable`; the port says `down`.
 *
 * This rename is not new — `odu hosts` has printed `down` since it had a STATE
 * column, because the column is five characters wide and an operator reading an
 * inventory wants the machine's condition, not the verb for what the probe
 * failed to do. Carrying it here rather than at each face is what keeps the
 * browser, the terminal and an agent from choosing three different words for
 * one state; `error` on the same row is where the probe's own sentence lives,
 * so nothing is lost by the shorter label.
 */
function venueState(probe: ProbeResult): VenueRowFacts["state"] {
  return probe.state === "unreachable" ? "down" : probe.state;
}

function rowFacts(platform: string, probe: ProbeResult): VenueRowFacts {
  return {
    platform,
    host: probe.host,
    slot: probe.slot,
    slots: probe.slots,
    state: venueState(probe),
    // Structurally `LeaseHolder` — `{ holder, run, sinceMs }` — spelled out so
    // the compiler proves the engine's shape and the port's are still the same
    // one, at the seam that is the only place both are in scope.
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

/**
 * Probe the configured venues — every one, or only the platforms asked for.
 *
 * The filter is not a convenience. A probe SSH-dials each machine, so an
 * unsliced inventory costs as long as the slowest box in it; an operator asking
 * about one platform should not wait on a datacentre they did not mention. An
 * EMPTY request means every platform, because "tell me everything" is the
 * question `odu hosts` with no argument has always asked.
 *
 * Two refusals, and both are the same rule: an empty table cannot say WHY it is
 * empty, and the two whys call for opposite actions.
 *
 *   - Nothing is configured at all — write a hosts file, versus wait.
 *   - Nothing the caller NAMED is configured — fix the name, versus wait. A
 *     face that got zero rows for `odu hosts x86_54-linux` would show an empty
 *     fleet rather than a typo.
 *
 * A request naming some platforms that exist and some that do not is neither:
 * the ones that exist are probed and the rest are reported as warnings, because
 * answering the answerable part beats refusing all of it over one typo.
 */
export async function venueInventory(request: {
  platforms: readonly string[];
  /** The CALLER's `$ODU_HOSTS`. This runs in the service, whose environment is
   *  a fact about the shell that started it — so without this, `odu hosts`
   *  reported the daemon's fleet while `odu run` used the caller's. */
  hostsFile: string | null;
}): Promise<VenueProbeOutcome> {
  const config = loadHosts(request.hostsFile ?? undefined);
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
  // A mixed pool is illegal at the lease seam, but refusing HERE would be the
  // juspay/odu#66 defect again: this probe never leases, so an illegal pool for
  // a platform you are not running is none of its business to refuse. It IS its
  // business to report — the inventory view is where an operator diagnoses
  // their hosts file, and before this warning the rule's only messenger was a
  // run that refused later. A WARNING and not stderr, because through the
  // service the operator is not necessarily attached to a terminal at all.
  // Only over the SLICE that was probed: warning about a pool this answer does
  // not contain would be diagnosing a file the caller did not ask about.
  for (const platform of platforms.filter((p) =>
    isMixedPool(config.hosts[p] ?? []),
  )) {
    warnings.push(
      `${config.source ?? "hosts config"}: host pool for "${platform}" mixes` +
        " localhost with remote hosts — any run that leases" +
        ` ${platform} will refuse it (use a pure-local or pure-remote pool)`,
    );
  }

  // The slice is what gets DIALLED, not what gets filtered afterwards — the
  // whole point of the filter is the round trips it does not make.
  const pools = Object.fromEntries(
    platforms.map((platform) => [platform, config.hosts[platform] ?? []]),
  );
  const runnerFlake = resolveRunnerFlake(process.env);
  const probed = await probeAllHosts(pools, {
    resolveDrvPath: (platform) => runnerDrvResolver(runnerFlake, platform),
  });
  return {
    ok: true,
    source: config.source,
    warnings,
    rows: probed.map(({ platform, probe }) => rowFacts(platform, probe)),
  };
}

