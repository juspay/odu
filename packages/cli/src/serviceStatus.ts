/**
 * `odu status` · `odu attach` — this checkout's run, as clients.
 *
 * These two were the last public commands holding a run authority of their own,
 * and the hardest to move, because what they show — which lane is claiming
 * which box, how long provisioning has been going, which GitHub contexts the
 * run still owes — was only ever answerable by the live coordinator. So they
 * dialled `.ci/odu.sock` directly, and a face allowed to dial a coordinator is
 * a face that can do anything to a run.
 *
 * **It turned out not to need the dial at all.** The coordinator has been
 * writing `lane` and `phase` lines into the durable journal all along and no
 * reader read them — `foldJournal` dropped both arms on the floor. Folding them
 * out and publishing them as `RunEnv` on the nodes frame makes every one of
 * those facts a catalog read, which the service already owns.
 *
 * That is not merely a shorter path to the same place. It changes what is
 * ANSWERABLE: a run whose coordinator was killed, or that finished last week,
 * can still say which machines it landed on and what it never managed to post.
 * A socket cannot be asked either question.
 *
 * ## "This checkout's run" is resolved on this side
 *
 * The service addresses runs globally, so `status` and `attach` — the two
 * commands whose subject genuinely IS a directory — resolve it here: read the
 * board, keep the rows whose `repoRoot` is this checkout, take the newest that
 * has not reached a terminal state. That is a fact about where the caller is
 * standing, which is the one kind of fact a face is still allowed to know.
 */

import { firstFrame as headFrame, subscribe } from "@odu/execution/common/effectEdge";
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
import { statusGlyph } from "./render";
import {
  checkoutHere,
  emitJson,
  readRows,
  WAIT_EXITS,
  withConnection,
} from "./serviceFace";

export interface HereRunOpts {
  json: boolean;
  origin?: string;
  cwd?: string;
}

/** A run is still this checkout's CURRENT one until it reaches a state nothing
 *  will move it out of. `owner_lost` counts as current on purpose: a run whose
 *  coordinator died without finalizing is exactly what a person standing in the
 *  checkout needs to be told about, and hiding it would send them looking for a
 *  run that "isn't there". */
const OVER = new Set(["settled", "expired"]);

/**
 * The newest run started from this checkout that has not finished.
 *
 * `undefined` when there is none, which is an ANSWER and not an error — a
 * checkout with no run in flight is the ordinary state of most checkouts most
 * of the time, and exiting non-zero for it would make `odu status` unusable in
 * a prompt.
 */
function currentRun(rows: readonly RunRow[], checkout: string): RunRow | undefined {
  return rows
    .filter((r) => r.repoRoot === checkout && !OVER.has(r.state))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

/** The frame both commands start from: the board resolved to a run, then that
 *  run's first nodes frame. Split out because `status` prints it once and
 *  `attach` keeps reading, and the resolution must not be two implementations. */
async function openHere<T>(
  opts: HereRunOpts,
  use: (client: OduServiceClient, row: RunRow) => Promise<T>,
  none: () => T,
): Promise<T> {
  const checkout = checkoutHere(opts.cwd);
  return withConnection(opts.origin, async (connection) => {
    const rows = await readRows(connection.dispatch);
    const row = currentRun(rows, checkout);
    if (row === undefined) return none();
    return use(connection.client, row);
  });
}

// ── odu status ──────────────────────────────────────────────────────────────

/**
 * `odu status` — where this checkout's run is right now, once.
 *
 * The JSON keeps the key names the socket-dialling version published
 * (`nodes` / `posting` / `run`), because scripts read them and re-pointing a
 * command at a different authority is not a reason to rename its output. The
 * VALUES are now catalog-derived, and two of them are better for it: `lanes`
 * survives the coordinator, and `owed` itemises the debt a bare count used to
 * summarise.
 */
export async function statusViaService(opts: HereRunOpts): Promise<number> {
  return openHere(
    opts,
    async (client, row) => {
      // A stream member is reached through `.get`, and a stream always opens
      // with a SNAPSHOT — so the head frame IS the read, with no polling and no
      // second call.
      const frame = await headFrame(client.surface.nodes.get({ runId: row.runId }));
      if (frame === undefined) {
        // A stream that opened and said nothing. Reported as itself rather than
        // as an empty run: "the service answered with no frame" and "this run
        // has no nodes" are different, and only the first is a fault.
        process.stderr.write(
          `odu: the service opened ${row.runId}'s node stream and sent no frame\n`,
        );
        return 3;
      }
      if (opts.json) {
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
      if (opts.json) emitJson({ run: null, nodes: [], posting: { owed: [] } });
      else process.stdout.write("no run in flight for this checkout\n");
      return 0;
    },
  );
}

/** One node, in the shape `odu status -o json` has always used — snake_case,
 *  because that is what the published contract says and a rename would break
 *  every script reading it. */
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
    // The same external wording every other plain face uses, so a green node
    // reads `success` in all of them. `??` keeps the states whose progress
    // mapping is null (pending) reading as their raw status.
    const word = STATUS_META[node.status].progress ?? node.status;
    const mark = owed.some((o) => o.context === node.id) ? yellow(" ⇐ github?") : "";
    out.push(`${statusGlyph(node.status)} ${word.padEnd(7)} ${node.id}${mark}`);
  }
  if (frame.nodes.length === 0) {
    out.push(`${row.runId} has no nodes yet`);
  }
  return `${out.join("\n")}\n`;
}

/**
 * The run-environment banner above the node rows.
 *
 * Printed only while a run is PROVISIONING, which is the window where the node
 * rows say nothing useful: every node is pending because no lane has a machine,
 * and an operator watching a multi-minute `nix copy` sees an idle-looking
 * matrix. Once the lanes have landed, the rows ARE the run's state and the
 * banner would be noise.
 */
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

/** `status` answers a question about a RUN, so it spends the run exit table. */
function statusExit(row: RunRow): number {
  if (row.state === "owner_lost") return WAIT_EXITS.ownerLost;
  if (!row.settled) return WAIT_EXITS.stillRunning;
  return row.passed ? WAIT_EXITS.passed : WAIT_EXITS.failed;
}

// ── odu attach ──────────────────────────────────────────────────────────────

/**
 * `odu attach` — the same run, followed until it stops moving.
 *
 * **The curses dashboard is gone, and its going is not incidental.** That view
 * — the matrix, `r` to rerun the focused node, a log pane beside it — was built
 * on a direct dial into the coordinator's own surface, which is precisely the
 * authority a public command may no longer hold. It is the cost of the thing
 * that was asked for rather than an oversight, and it is said out loud here and
 * in the usage text rather than left for somebody to discover.
 *
 * What replaces it is the transition stream both faces of the old command
 * shared: every frame that differs from the last, rendered as it arrives. That
 * is what a person piping `odu attach` into a file wanted, what an agent can
 * use, and what survives a coordinator restart — none of which was true of a
 * matrix bound to one socket.
 *
 * Restoring the interactive view over the service is possible and is not being
 * deferred quietly: `streams.nodes` carries the live statuses, `pipeline.read`
 * carries the DAG the catalog deliberately does not store, and `log.read` with
 * `waitMs` carries the log pane. What it needs is an adapter from those three
 * onto `liveView`'s `PipelineState` / `NodeLogFrame` shapes — and shipping a
 * subtly-wrong TUI would be worse than shipping none.
 *
 * Ctrl-C ends the WATCHING. The run is a detached process group with its
 * evidence in the catalog; interrupting here changes nothing about it, which is
 * the same asymmetry `odu run` keeps.
 */
export async function attachViaService(opts: HereRunOpts): Promise<number> {
  return openHere(
    opts,
    async (client, row) => {
      let last = "";
      let final: NodesFrame | undefined;
      for await (const frame of subscribe(
        client.surface.nodes.get({ runId: row.runId }),
      )) {
        final = frame;
        if (opts.json) {
          emitJson({
            run: row.runId,
            phase: frame.env.phase,
            state: frame.state,
            nodes: frame.nodes.map(nodeJson),
            done: frame.done,
          });
        } else {
          // Only what CHANGED reaches the terminal. A frame is only sent when
          // something moved, but "something moved" includes a lane landing on a
          // box, which does not change a single node row — so a face that
          // printed every frame would repeat the matrix for a reason the reader
          // cannot see.
          const painted = renderStatus(frame, row);
          if (painted !== last) {
            process.stdout.write(painted);
            last = painted;
          }
        }
        if (frame.done) break;
      }
      if (final === undefined) {
        process.stderr.write(
          `odu: the service opened ${row.runId}'s node stream and sent no frame\n`,
        );
        return 3;
      }
      // The FINAL frame decides the exit, not the row we resolved at the start:
      // by the time a follow ends, the row is minutes stale.
      if (final.state === "owner_lost") return WAIT_EXITS.ownerLost;
      if (!final.done) return WAIT_EXITS.stillRunning;
      return final.nodes.some((n) => STATUS_META[n.status].isRed)
        ? WAIT_EXITS.failed
        : WAIT_EXITS.passed;
    },
    () => {
      process.stderr.write("odu: no run in flight for this checkout\n");
      return 0;
    },
  );
}
