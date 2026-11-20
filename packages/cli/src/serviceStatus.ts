import { randomUUID } from "node:crypto";
import { isNoAnswer, runUnary } from "@odu/execution/common/effectEdge";
import { exitCode } from "@odu/execution/common/verdict";
import { STATUS_META } from "@odu/run-client/surface";
import type {
  NodesFrame,
  OduServiceClient,
  RunEnv,
  RunLane,
  RunNode,
  RunRow,
} from "@odu/service-client/surface";
import { yellow } from "./ansi";
import { createDisplay } from "./display";
import {
  headerOf,
  nodeLogStream,
  pipelineStateOf,
  verdictStateOf,
} from "./liveFromService";
import { statusGlyph } from "./render";
import {
  checkoutHere,
  emitJson,
  findRuns,
  firstNodesFrame,
  type Patience,
  patience,
  reportNoAnswer,
  watchNodes,
  WAIT_EXITS,
  withService,
} from "./serviceFace";

export interface HereRunOpts {
  json: boolean;
  origin?: string;
  cwd?: string;
}

export type HereClient = Pick<OduServiceClient, "surface">;

const NOTHING_TO_SHOW = new Set(["expired"]);

function currentRun(newest: RunRow | undefined): RunRow | undefined {
  return newest === undefined || NOTHING_TO_SHOW.has(newest.state)
    ? undefined
    : newest;
}

async function resolveHere(
  client: HereClient,
  checkout: string,
  p: Patience,
  use: (row: RunRow) => Promise<number>,
  none: () => number,
): Promise<number> {
  const found = await findRuns(client, { checkout, limit: 1 }, p);
  if (!found.ok) return found.exit;
  const row = currentRun(found.value.rows[0]);
  return row === undefined ? none() : use(row);
}

export async function statusViaService(opts: HereRunOpts): Promise<number> {
  const checkout = checkoutHere(opts.cwd);
  const p = patience(opts.origin, opts.json);
  return withService(opts.origin, (client) => statusWith(client, checkout, p), p.notice);
}

export async function statusWith(
  client: HereClient,
  checkout: string,
  p: Patience,
): Promise<number> {
  return resolveHere(
    client,
    checkout,
    p,
    async (row) => {
      const opened = await firstNodesFrame(client, row.runId, p);
      if (!opened.ok) return opened.exit;
      const frame = opened.value;
      if (frame === undefined) {
        process.stderr.write(
          `odu: the service opened ${row.runId}'s node stream and sent no frame\n`,
        );
        return 3;
      }
      if (p.json) {
        emitJson({
          run: {
            id: row.runId,
            phase: frame.env.phase,
            elapsed_ms: frame.env.elapsedMs,
            lanes: frame.env.lanes,
            hosts_source: frame.env.hostsSource,
            commit_url: frame.env.commitUrl,
          },
          nodes: frame.nodes.map(nodeJson),
          posting: { owed: frame.env.owed },
        });
      } else {
        process.stdout.write(renderStatus(frame, row));
      }
      return statusExit(row);
    },
    () => {
      if (p.json) emitJson({ run: null, nodes: [], posting: { owed: [] } });
      else process.stdout.write("no run in flight for this checkout\n");
      return 0;
    },
  );
}

function nodeJson(node: RunNode): {
  id: string;
  status: string;
  attempt: number;
  exit_code: number | null;
  duration_ms: number | null;
  host: string | null;
  log_key: string;
} {
  return {
    id: node.id,
    status: node.status,
    attempt: node.attempt,
    exit_code: node.exitCode,
    duration_ms: node.durationMs === null ? null : Math.round(node.durationMs),
    host: node.host,
    log_key: node.logKey,
  };
}

export function renderStatus(frame: NodesFrame, row: RunRow): string {
  const out: string[] = [];
  const owed = frame.env.owed;
  if (owed.length > 0) {
    out.push(
      yellow(
        `odu: ${owed.length} commit status${owed.length === 1 ? "" : "es"} ` +
          "could not be posted — this run's verdict is sound, its reporting is not",
      ),
    );
  }
  out.push(...envLines(frame.env));
  for (const node of frame.nodes) {
    const word = STATUS_META[node.status].progress ?? node.status;
    const mark = owed.some((o) => o.context === node.id) ? yellow(" ⇐ github?") : "";
    out.push(`${statusGlyph(node.status)} ${word.padEnd(7)} ${node.id}${mark}`);
  }
  if (frame.nodes.length === 0) {
    out.push(`${row.runId} has no nodes yet`);
  }
  return `${out.join("\n")}\n`;
}

function envLines(env: RunEnv): string[] {
  if (env.phase !== "provisioning") return [];
  const lines: string[] = [];
  lines.push(
    env.elapsedMs === null
      ? "provisioning"
      : `provisioning ${Math.round(env.elapsedMs / 1000)}s`,
  );
  const claiming = env.lanes.filter((l): l is Extract<RunLane, { state: "claiming" }> =>
    l.state === "claiming",
  );
  if (claiming.length > 0) {
    lines.push(
      `  claiming ${claiming
        .map((l) => `${l.platform}=${l.pool.length === 0 ? "?" : l.pool.join("|")}`)
        .join(" ")}`,
    );
  }
  const leased = env.lanes.filter((l): l is Extract<RunLane, { state: "leased" }> =>
    l.state === "leased",
  );
  if (leased.length > 0) {
    lines.push(`  lanes ${leased.map((l) => `${l.platform}=${l.host}`).join(" ")}`);
  }
  if (env.hostsSource !== null) lines.push(`  hosts ${env.hostsSource}`);
  return lines;
}

function statusExit(row: RunRow): number {
  if (row.state === "owner_lost") return WAIT_EXITS.ownerLost;
  if (!row.settled) return 0;
  return row.passed ? 0 : 1;
}

export async function attachViaService(opts: HereRunOpts): Promise<number> {
  const checkout = checkoutHere(opts.cwd);
  const p = patience(opts.origin, opts.json);
  return withService(
    opts.origin,
    (client) =>
      attachWith(client, checkout, p, {
        live: !opts.json && process.stdout.isTTY === true ? attachLive : null,
      }),
    p.notice,
  );
}

export async function attachWith(
  client: HereClient,
  checkout: string,
  p: Patience,
  deps: {
    live: ((client: HereClient, row: RunRow, p: Patience) => Promise<number>) | null;
  },
): Promise<number> {
  return resolveHere(
    client,
    checkout,
    p,
    async (row) => {
      try {
        return await (deps.live === null
          ? attachStream(client, row, p)
          : deps.live(client, row, p));
      } catch (err) {
        if (isNoAnswer(err)) return reportNoAnswer(p, `${row.runId}'s nodes`);
        throw err;
      }
    },
    () => {
      process.stderr.write("odu: no run in flight for this checkout\n");
      return 0;
    },
  );
}

async function attachStream(
  client: HereClient,
  row: RunRow,
  p: Patience,
): Promise<number> {
  let last = "";
  const final = await watchNodes(client, row.runId, (frame) => {
    if (p.json) {
      emitJson({
        run: row.runId,
        phase: frame.env.phase,
        state: frame.state,
        nodes: frame.nodes.map(nodeJson),
        done: frame.done,
      });
    } else {
      const painted = renderStatus(frame, row);
      if (painted !== last) {
        process.stdout.write(painted);
        last = painted;
      }
    }
  }, { patience: p });
  if (final === undefined) {
    process.stderr.write(
      `odu: the service opened ${row.runId}'s node stream and sent no frame\n`,
    );
    return 3;
  }
  return frameExit(final);
}

async function attachLive(
  client: HereClient,
  row: RunRow,
  p: Patience,
): Promise<number> {
  let latest: NodesFrame | undefined;
  const logKeyOf = (id: string): string =>
    latest?.nodes.find((n) => n.id === id)?.logKey ?? "";

  const view = createDisplay("live", {
    interactive: true,
    hookStderr: false,
    openLog: (id) => nodeLogStream(client, logKeyOf(id)),
    rerun: (id) => {
      void runUnary(
        client.surface.run.retry({
          runId: row.runId,
          selector: id,
          requestId: `attach-${randomUUID()}`,
        }),
      ).catch(() => {});
    },
    onQuit: () => {
      view.stop(latest === undefined ? undefined : pipelineStateOf(latest, row));
      process.exit(latest === undefined ? 0 : frameExit(latest));
    },
  });

  let started = false;
  await watchNodes(client, row.runId, (frame) => {
    latest = frame;
    const state = pipelineStateOf(frame, row);
    view.setHeader(headerOf(frame.env, Date.now()));
    if (!started) {
      view.start(state);
      started = true;
    } else {
      view.update(state);
    }
  }, { patience: p });
  view.stop(latest === undefined ? undefined : pipelineStateOf(latest, row));
  return latest === undefined ? 3 : frameExit(latest);
}

function frameExit(frame: NodesFrame): number {
  if (frame.state === "owner_lost") return WAIT_EXITS.ownerLost;
  return exitCode(verdictStateOf(frame, ""));
}
