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

import { randomUUID } from "node:crypto";
import {
  firstFrame as headFrame,
  runUnary,
  subscribe,
} from "@odu/execution/common/effectEdge";
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
  readRows,
  WAIT_EXITS,
  withConnection,
} from "./serviceFace";

export interface HereRunOpts {
  json: boolean;
  origin?: string;
  cwd?: string;
}

/** The one state with nothing left to show. `expired` means retention has
 *  removed the evidence — the run's identity survives, its nodes and logs do
 *  not — so there is no grid to draw. Everything else, including `settled` and
 *  `owner_lost`, is a run a person standing here wants to see. */
const NOTHING_TO_SHOW = new Set(["expired"]);

/**
 * The newest run started from this checkout.
 *
 * NEWEST FIRST, THEN THE STATE TEST, and both halves of that were wrong before.
 *
 * Filtering by state and sorting the survivors reads the same as this and is
 * not: an `owner_lost` run never leaves that state, so it stayed "current"
 * forever and SHADOWED every run started after it. `odu status` in this very
 * checkout spent an hour reporting an abandoned run's nodes as `running` while
 * the run the person had actually just started sat settled in the catalog,
 * with the two disagreeing on screen. A dead run is news only while it is the
 * last thing that happened here.
 *
 * And "has not finished" was the wrong test to begin with. A settled run is
 * the most likely thing somebody typing `odu status` wants — they just ran CI
 * and want the grid. Excluding it also broke the one feature whose entire
 * purpose is being asked after settlement: `odu run --linger` parks the
 * coordinator precisely so a caller can look afterwards, and `status` answered
 * "no run in flight for this checkout".
 *
 * `undefined` when this checkout has never run, or when retention has removed
 * the only run's evidence. That is an ANSWER and not an error — a checkout with
 * no run is the ordinary state of most checkouts most of the time, and exiting
 * non-zero for it would make `odu status` unusable in a prompt.
 */
function currentRun(rows: readonly RunRow[], checkout: string): RunRow | undefined {
  const newest = rows
    .filter((r) => r.repoRoot === checkout)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  return newest === undefined || NOTHING_TO_SHOW.has(newest.state)
    ? undefined
    : newest;
}

/** The frame both commands start from: the board resolved to a run, then that
 *  run's first nodes frame. Split out because `status` prints it once and
 *  `attach` keeps reading, and the resolution must not be two implementations. */
async function openHere(
  opts: HereRunOpts,
  use: (client: OduServiceClient, row: RunRow) => Promise<number>,
  none: () => number,
): Promise<number> {
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
  // A run still going is the ORDINARY case, not an outcome — see `frameExit`.
  // `odu status` reports what is true now; a script shaped `odu status && …`
  // must not be told "2" for a run that is simply in progress.
  if (!row.settled) return 0;
  return row.passed ? 0 : 1;
}

// ── odu attach ──────────────────────────────────────────────────────────────

/**
 * `odu attach` — the same run, followed until it stops moving.
 *
 * **The matrix is the same matrix.** `odu attach` in a terminal opens the live
 * view it always has — the node grid, `r` to rerun the focused node, the log
 * pane beside it — and NOTHING about that is allowed to change here. It used to
 * be fed by a direct dial into the coordinator's own surface, which is the
 * authority a public command may no longer hold; it is fed from the shared
 * service now, through `./liveFromService`. The plumbing moved. The view did
 * not, because a consolidation that costs a person their dashboard is a
 * consolidation that has taken something from them.
 *
 * Piped or `-o json`, it is the transition stream instead — every frame that
 * differs from the last. That is not a lesser fallback, it is the right thing
 * for a non-terminal: `createDisplay` has always chosen between live, plain and
 * json on exactly this basis, and the choice is made here for the same reason.
 *
 * Ctrl-C ends the WATCHING. The run is a detached process group with its
 * evidence in the catalog; interrupting here changes nothing about it, which is
 * the same asymmetry `odu run` keeps.
 */
export async function attachViaService(opts: HereRunOpts): Promise<number> {
  return openHere(
    opts,
    async (client, row) => {
      // A TERMINAL GETS THE MATRIX. The same rule `createDisplay` has always
      // applied: interactive when there is a tty to be interactive on, and the
      // stream otherwise.
      if (!opts.json && process.stdout.isTTY === true) {
        return attachLive(client, row);
      }
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

/**
 * The live dashboard, fed from the shared service.
 *
 * Every fact the view wants is on the surface: the node grid and the lane
 * roster from `streams.nodes` (its frame carries `env`), an attempt's output
 * from `log.read` with `waitMs`, and `r` from `run.retry`. `./liveFromService`
 * maps those onto the shapes `liveView` was written against, so there is one
 * matrix rather than two that have to be kept identical.
 */
async function attachLive(
  client: OduServiceClient,
  row: RunRow,
): Promise<number> {
  let latest: NodesFrame | undefined;
  /** The focused node's log ADDRESS, from the frame that drew it — never
   *  reassembled here. A face that built its own log key would be a second
   *  spelling of an address the service already published. */
  const logKeyOf = (id: string): string =>
    latest?.nodes.find((n) => n.id === id)?.logKey ?? "";

  const view = createDisplay("live", {
    interactive: true,
    hookStderr: false,
    openLog: (id) => nodeLogStream(client, logKeyOf(id)),
    // Fire-and-forget, as it always was: a refused retry shows up as the node
    // not moving. What matters is that the call is DISPATCHED — an Effect that
    // is merely described does nothing, which is how `r` once silently stopped
    // working with nothing in the type system to say so.
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
  for await (const frame of subscribe(
    client.surface.nodes.get({ runId: row.runId }),
  )) {
    latest = frame;
    const state = pipelineStateOf(frame, row);
    // The header BEFORE the first paint: a run attached to during provisioning
    // — which is exactly when somebody reaches for a dashboard — would
    // otherwise show the claiming line for its whole life.
    view.setHeader(headerOf(frame.env, Date.now()));
    if (!started) {
      view.start(state);
      started = true;
    } else {
      view.update(state);
    }
    if (frame.done) break;
  }
  view.stop(latest === undefined ? undefined : pipelineStateOf(latest, row));
  return latest === undefined ? 3 : frameExit(latest);
}

/** The exit a finished frame earns, on the shared run table. */
/**
 * What `status` and `attach` exit with — and it is NOT the run-shaped table.
 *
 * `WAIT_EXITS` numbers the states of a WAIT: passed, red, still going, owner
 * lost. `odu status` does not wait; it prints what is true now, and a run that
 * is still going is the ordinary case rather than an outcome. Reporting that as
 * `2` broke every script shaped `odu status && …`, including this repo's own
 * e2e helper, whose "is a run live here?" probe read any non-zero as "no" and
 * then waited two minutes for a run that had been up the whole time.
 *
 * So: `exitCode`'s rule, which is what these two commands shipped with — 1 for
 * a run that FINISHED and is not clean, 0 otherwise. `owner_lost` keeps its own
 * code because a coordinator that died without finalizing is neither, and it is
 * the one case where the previous implementation also failed (it could not dial
 * at all).
 */
function frameExit(frame: NodesFrame): number {
  if (frame.state === "owner_lost") return WAIT_EXITS.ownerLost;
  return exitCode(verdictStateOf(frame, ""));
}
