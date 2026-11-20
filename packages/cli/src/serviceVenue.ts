import type {
  VenueProbeOutput,
  VenueRow,
} from "@odu/service-client/surface";
import {
  hostsFileHere,
  call,
  checkoutHere,
  emitJson,
  formatAgo,
  reportFailure,
  requestId,
  withService,
} from "./serviceFace";

export interface HostsOpts {
  platforms: readonly string[];
  json: boolean;
  origin?: string;
  cwd?: string;
}

export async function hostsViaService(opts: HostsOpts): Promise<number> {
  return withService(opts.origin, async (client) => {
    const probed = await call(
      client.surface.venue.probe({
        platforms: opts.platforms,
        hostsFile: hostsFileHere(opts.cwd),
      }),
    );
    if (!probed.ok) return reportFailure(probed, opts.json);
    const answer: VenueProbeOutput = probed.value;
    if (opts.json) {
      emitJson(answer);
      return 0;
    }
    for (const warning of answer.warnings) {
      process.stderr.write(`odu: warning: ${warning}\n`);
    }
    process.stdout.write(renderVenues(answer.rows, Date.now()));
    return 0;
  });
}

function venueLabel(row: VenueRow): string {
  return row.slots > 1 ? `${row.host}#${row.slot + 1}/${row.slots}` : row.host;
}

type HeldCell =
  | { kind: "held"; text: string }
  | { kind: "error"; text: string }
  | { kind: "none" };

function heldCell(row: VenueRow, nowMs: number): HeldCell {
  if (row.state === "busy" && row.heldBy !== null) {
    const who = row.heldBy;
    const held = formatAgo(nowMs - who.sinceMs);
    return {
      kind: "held",
      text:
        who.run === null
          ? `${who.holder} (${held})`
          : `${who.holder} · ${who.run} (${held})`,
    };
  }
  if (row.state === "down") {
    return { kind: "error", text: row.error ?? "unreachable" };
  }
  return { kind: "none" };
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
    const cell = heldCell(row, nowMs);
    const head =
      `${venueLabel(row).padEnd(hostW)}  ${row.platform.padEnd(platW)}  ` +
      row.state.padEnd(stateW);
    lines.push(cell.kind === "none" ? head.trimEnd() : `${head}  ${cell.text}`);
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

export async function leaseViaService(opts: LeaseOpts): Promise<number> {
  const checkout = checkoutHere(opts.cwd);
  return withService(opts.origin, async (client) => {
    const held = await call(
      client.surface.venue.hold({
        checkout,
        platforms: opts.platforms,
        hostsFile: hostsFileHere(opts.cwd),
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

export async function releaseViaService(opts: ReleaseOpts): Promise<number> {
  const checkout = checkoutHere(opts.cwd);
  return withService(opts.origin, async (client) => {
    const done = await call(
      client.surface.venue.release({
        checkout,
        platforms: opts.platforms,
        hostsFile: hostsFileHere(opts.cwd),
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
