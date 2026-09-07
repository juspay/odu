/**
 * `odu hosts` · `odu lease` · `odu release` — the machines, as clients.
 *
 * All three used to reach the engine directly. `odu hosts` imported
 * `probeAllHosts` and ssh-dialled every configured box from the caller's own
 * process; `odu lease` forked a detached `odu lease-hold` out of the caller's
 * shell and wrote the per-checkout lease record itself; `odu release` sent
 * SIGTERM to a pid it read off that record. Between them they were a second
 * venue authority — one that the board could not see, that an agent could not
 * reach at all, and that disagreed with the coordinator's own lease layer about
 * who held what for as long as it took somebody to notice.
 *
 * **A hold's lifetime changed, and it changed for the better.** The holder is
 * now the SERVICE's child rather than the terminal's. `odu lease` always
 * promised a venue "held across runs", and that promise was quietly false: the
 * hold died with whatever shell took it. Parented by the daemon it is true, and
 * it is the only arrangement under which a browser or an agent can take one —
 * neither of them has a shell to be the parent.
 *
 * Nothing here decides anything about placement. Which machine is free, what a
 * mixed pool means, whether a claim can be honoured: all of that is the
 * service's, reached through `venue.probe` / `venue.hold` / `venue.release`.
 * This file is columns and exit codes.
 */

import type {
  VenueProbeOutput,
  VenueRow,
} from "@odu/service-client/surface";
import {
  call,
  checkoutHere,
  emitJson,
  formatAgo,
  reportFailure,
  requestId,
  withService,
} from "./serviceFace";

export interface HostsOpts {
  /** Only these platforms. Empty means every configured one. */
  platforms: readonly string[];
  json: boolean;
  origin?: string;
}

/**
 * `odu hosts [PLAT…]` — every configured venue and whether it is free.
 *
 * A machine with four slots prints four rows, because a slot is what a run
 * actually takes: collapsing them would make a box with three slots free look
 * the same as a full one.
 *
 * Naming platforms is a real filter rather than a display convenience — a probe
 * SSH-dials each machine, so an inventory read is as slow as its slowest box,
 * and asking about one platform should not wait for a datacentre you do not
 * care about. The service slices the inventory before it dials.
 */
export async function hostsViaService(opts: HostsOpts): Promise<number> {
  return withService(opts.origin, async (client) => {
    const probed = await call(
      client.surface.venue.probe({ platforms: opts.platforms }),
    );
    if (!probed.ok) return reportFailure(probed, opts.json);
    const answer: VenueProbeOutput = probed.value;
    if (opts.json) {
      emitJson(answer);
      return 0;
    }
    // Warnings on stderr, inventory on stdout — so `odu hosts | column -t`
    // still works while a misconfigured pool still gets said out loud.
    for (const warning of answer.warnings) {
      process.stderr.write(`odu: warning: ${warning}\n`);
    }
    process.stdout.write(renderVenues(answer.rows, Date.now()));
    return 0;
  });
}

/** A venue's label: the short host, with `#slot/slots` only when there is more
 *  than one — a bare hostname is the common case and `builder-1#1/1` is noise
 *  that makes the useful case harder to scan. */
function venueLabel(row: VenueRow): string {
  return row.slots > 1 ? `${row.host}#${row.slot + 1}/${row.slots}` : row.host;
}

function heldColumn(row: VenueRow, nowMs: number): string {
  if (row.state === "busy" && row.heldBy !== null) {
    const who = row.heldBy;
    const held = formatAgo(nowMs - who.sinceMs);
    return who.run === null
      ? `${who.holder} (${held})`
      : `${who.holder} · ${who.run} (${held})`;
  }
  // A `down` row's error IS the held-by column's content: the question a reader
  // has about an unreachable box is why, and there is nothing else to put here.
  return row.state === "down" ? (row.error ?? "unreachable") : "";
}

export function renderVenues(rows: readonly VenueRow[], nowMs: number): string {
  if (rows.length === 0) return "no venues\n";
  const hostW = Math.max(4, ...rows.map((r) => venueLabel(r).length));
  const platW = Math.max(8, ...rows.map((r) => r.platform.length));
  const stateW = 5;
  const lines = [
    `${"HOST".padEnd(hostW)}  ${"PLATFORM".padEnd(platW)}  ${"STATE".padEnd(stateW)}  HELD BY`,
  ];
  for (const row of rows) {
    const held = heldColumn(row, nowMs);
    const head =
      `${venueLabel(row).padEnd(hostW)}  ${row.platform.padEnd(platW)}  ` +
      row.state.padEnd(stateW);
    lines.push(held === "" ? head.trimEnd() : `${head}  ${held}`);
  }
  return `${lines.join("\n")}\n`;
}

export interface LeaseOpts {
  platforms: readonly string[];
  noWait: boolean;
  json: boolean;
  origin?: string;
  cwd?: string;
}

/**
 * `odu lease [PLAT…]` — hold a venue for this checkout, across runs.
 *
 * The exit is 0 for `held` and `already`, and 2 for `waiting` — the same
 * "nothing is wrong and nothing is finished" code `odu wait` uses when a run is
 * still going. A caller scripting this branches on it to decide whether to
 * queue behind the incumbent or go away.
 *
 * The call ANSWERS as soon as each holder is spawned rather than blocking until
 * the venue is free. Blocking was a property of the old shell-parented holder;
 * through the service it would mean holding a request open for however long
 * somebody else's run takes, on a door a browser and an agent share. A queued
 * platform comes back `waiting` with who it is behind, and `odu hosts` is how
 * you watch for it to clear.
 */
export async function leaseViaService(opts: LeaseOpts): Promise<number> {
  const checkout = checkoutHere(opts.cwd);
  return withService(opts.origin, async (client) => {
    const held = await call(
      client.surface.venue.hold({
        checkout,
        platforms: opts.platforms,
        noWait: opts.noWait,
        requestId: requestId(undefined),
      }),
    );
    if (!held.ok) return reportFailure(held, opts.json);
    const answer = held.value;
    if (opts.json) {
      emitJson(answer);
    } else {
      for (const result of answer.results) {
        process.stdout.write(`${result.message}\n`);
      }
    }
    return answer.results.some((r) => r.status === "waiting") ? 2 : 0;
  });
}

export interface ReleaseOpts {
  platforms: readonly string[];
  json: boolean;
  origin?: string;
  cwd?: string;
}

/** `odu release [PLAT…]` — drop this checkout's holds. Releasing something
 *  nobody held is an ANSWER (`nothing`), not an error: it is the state the
 *  caller asked for. */
export async function releaseViaService(opts: ReleaseOpts): Promise<number> {
  const checkout = checkoutHere(opts.cwd);
  return withService(opts.origin, async (client) => {
    const done = await call(
      client.surface.venue.release({
        checkout,
        platforms: opts.platforms,
        requestId: requestId(undefined),
      }),
    );
    if (!done.ok) return reportFailure(done, opts.json);
    const answer = done.value;
    if (opts.json) {
      emitJson(answer);
      return 0;
    }
    for (const row of answer.released) {
      process.stdout.write(
        row.effective === "released"
          ? `released ${row.platform}${row.host === null ? "" : ` (${row.host})`}\n`
          : `${row.platform}: ${row.detail ?? "nothing was held"}\n`,
      );
    }
    if (answer.released.length === 0) {
      process.stdout.write("nothing was held\n");
    }
    return 0;
  });
}
