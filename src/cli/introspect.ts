/**
 * In-band commands against a live run — `odu status` / `logs` / `attach`
 * attach to the coordinator's fan-in surface on `.ci/odu.sock`; `odu cancel`
 * drives its teardown; `odu wait` blocks for a settle/fail-fast verdict; and
 * `odu rerun` is the headless face of the surface `node.rerun` procedure.
 * The same primitives every face speaks: one snapshot of the `nodes` cell, a
 * log stream with snapshot-then-append replay, the dashboard with `r`erun, and
 * the `run.cancel` lifecycle mutation.
 *
 * `status -o json` emits `{ nodes, posting }` (not a bare array) so GitHub
 * reporting health is machine-readable (juspay/odu#61). `wait` prints the
 * MCP `wait_for_settle` verdict shape as one JSON line.
 */

import {
  type NodeLogFrame,
  type NodeState,
  type OduClient,
  type PipelineState,
  postingOf,
  type RunHeader,
  type RunLane,
  type RunPhase,
  runPhase,
  STATUS_META,
} from "@odu/run-client/surface";
import { isSetupNode, onPlatform, splitFanId } from "@odu/run-client/nodeId";
import { dirname } from "node:path";
import { dialRun, SOCKET_PATH } from "@odu/run-client/dial";
import { deadRun, describeDeadRun } from "@odu/run-client/deadRun";
import { firstFrame, runUnary, subscribe } from "../common/effectEdge";
import { formatGoDuration } from "../common/duration";
import { parseAtPlatform, transitiveDependents } from "../common/nodeId";
import { cancelNodeOrPlatform, cancelRun } from "../coordinator/cancel";
import { createDisplay, progressEvent } from "../coordinator/display";
import {
  dialRunOrExit,
  feedDroppedMessage,
  noRunInProgressMessage,
} from "../coordinator/socket";
import { postingWarning } from "../coordinator/statuses";
import { isDeadTransportError } from "@kolu/surface/errors";
import { NoLiveRunError, waitForSettle } from "../coordinator/waitForSettle";
import { agentReaderForSocket } from "../mcp/agentSurface";
import { yellow } from "./ansi";
import {
  claimingText,
  exitCode,
  laneText,
  nodeRow,
  statusGlyph,
  summarize,
  verdictLine,
} from "./render";

export async function firstSnapshot(client: OduClient): Promise<PipelineState> {
  const state = await firstFrame(client.surface.nodes.get(undefined));
  if (state === undefined) {
    throw new Error("odu: coordinator closed before sending state");
  }
  return state;
}

/** The run header off the surface, AS OF DIAL TIME — a SNAPSHOT, which is what
 *  the name is for. `run` serves the socket before it claims a machine
 *  (juspay/odu#84) and publishes the header twice, so this is not the run's
 *  final lane roster; a one-shot face (`odu status`) wants exactly that, the
 *  environment as it stands right now, and anything that outlives one snapshot
 *  subscribes to the cell instead (see `attachDashboard`, whose header loop is
 *  its only header path).
 *
 *  The `header` cell always yields its current value, so an empty stream means
 *  the coordinator closed before sending — a protocol failure we surface rather
 *  than mask with a blank banner (mirrors `firstSnapshot`). */
export async function headerSnapshot(client: OduClient): Promise<RunHeader> {
  const header = await firstFrame(client.surface.header.get(undefined));
  if (header === undefined) {
    throw new Error("odu: coordinator closed before sending header");
  }
  return header;
}

/** All live node ids matching a CLI token: exact id, `::token` / `::token@`
 *  suffix-ish forms, or full namepath. Shared by unique resolve (`logs`) and
 *  multi-match expand (`rerun` recipe-wide). */
export function matchNodeIds(state: PipelineState, token: string): string[] {
  if (state.nodes[token] !== undefined) return [token];
  return state.order.filter((id) => {
    if (id === token) return true;
    if (id.endsWith(`::${token}`) || id.includes(`::${token}@`)) return true;
    return splitFanId(id).namepath === token;
  });
}

/** Resolve a node argument against the live state: exact id, or unique
 *  suffix-ish match (`e2e@x86_64-linux` ≡ `ci::e2e@x86_64-linux`). */
export function resolveNodeId(state: PipelineState, token: string): string {
  const matches = matchNodeIds(state, token);
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  throw new Error(
    matches.length === 0
      ? `odu: no node matches "${token}" (try: ${state.order.join(", ")})`
      : `odu: "${token}" is ambiguous (${matches.join(", ")})`,
  );
}

/** When this run started provisioning: the earliest `_ci-setup@<platform>` that
 *  is still `running`, which the coordinator stamps at the venue claim. Null
 *  when no lane's bracket is open. */
function setupStartedAt(state: PipelineState): number | null {
  const starts = state.order
    .filter((id) => isSetupNode(id) && state.nodes[id]?.status === "running")
    .map((id) => state.nodes[id]?.startedAt)
    .filter((t): t is number => typeof t === "number");
  return starts.length === 0 ? null : Math.min(...starts);
}

/** The run-environment block `odu status` prints above the node rows while a
 *  run is still PROVISIONING — which host(s) each lane is claiming and how long
 *  it has been at it (juspay/odu#84). Nothing once every lane has a machine: the
 *  node rows are the run's state then, and a run that reached its lanes keeps
 *  the output it has always had. */
export function provisioningLines(
  header: RunHeader,
  state: PipelineState,
  nowMs = Date.now(),
): string[] {
  if (runPhase(header) !== "provisioning") return [];
  // The PROVISIONING clock, off the bracket that measures it. `header.startedAt`
  // is the RUN start — captured before the socket serves, before signals, before
  // `poster.seed()`'s GitHub round trip — so the number under the word
  // "provisioning" was not the provisioning duration. `_ci-setup@<platform>`
  // is stamped `running` at the claim itself; the earliest one still running is
  // when this run began provisioning. `header.startedAt` is the fallback only in
  // principle: `runPhase` above already answered `provisioning`, which it never
  // does for the pre-publish `startedAt === 0` header.
  const since = setupStartedAt(state) ?? header.startedAt;
  const lines = [`provisioning ${formatGoDuration(nowMs - since)}`];
  const claiming = claimingText(header);
  if (claiming !== "") lines.push(`  claiming ${claiming}`);
  // A partly-claimed multi-platform run: the lanes that already have a machine.
  const lanes = laneText(header);
  if (lanes !== "") lines.push(`  lanes ${lanes}`);
  return lines;
}

/** The machine-readable run environment on `odu status -o json`. Additive: the
 *  `nodes` / `posting` keys older readers use are untouched. `elapsed_ms` is
 *  null only for a header no run ever published.
 *
 *  One `lanes` array carrying each entry's `state`, not two arrays a reader has
 *  to zip: an agent asking "where is this run" gets the roster in one traversal,
 *  in the run's own platform order. */
export function runEnvJson(
  header: RunHeader,
  nowMs = Date.now(),
): {
  phase: RunPhase;
  elapsed_ms: number | null;
  lanes: RunLane[];
} {
  return {
    phase: runPhase(header),
    elapsed_ms: header.startedAt > 0 ? nowMs - header.startedAt : null,
    // The roster verbatim: it already IS `RunLane[]`, and reconstructing it
    // field-by-field per variant was two branches that had to track
    // `RunLaneSchema` by hand.
    lanes: [...header.lanes],
  };
}

export async function statusCommand(
  json: boolean,
  socketPath?: string,
): Promise<number> {
  const { client, close } = await dialRunOrExit(socketPath);
  // The run environment, read from the same dial: a run that has no lanes yet
  // has nothing to say through `nodes` alone, and "no rows" is exactly the
  // ambiguity juspay/odu#84 is about.
  //
  // BEFORE the rows, not after: these are two cells read at two instants, and
  // the banner heads the rows. A header at least as old as the rows can
  // under-report (say `provisioning` while the rows have moved on by a few ms);
  // read after them it could assert a phase the rows have already left, which
  // is the direction that reads as a contradiction. Note this read can THROW on
  // a coordinator whose header cell closes empty — deliberately, as a protocol
  // failure — so it now fails before any rows are printed rather than after.
  const header = await headerSnapshot(client);
  const state = await firstSnapshot(client);
  await close();
  const posting = postingOf(state);
  if (json) {
    const rows = state.order
      .map((id) => state.nodes[id])
      .filter((n): n is NonNullable<typeof n> => n !== undefined)
      .map(nodeRow);
    // Object form carries posting health verbatim (juspay/odu#61); older
    // clients that expected a bare array should read `.nodes`.
    process.stdout.write(
      `${JSON.stringify({ nodes: rows, posting, run: runEnvJson(header) }, null, 2)}\n`,
    );
  } else {
    const warn = postingWarning(posting);
    if (warn !== null) process.stderr.write(`${yellow(warn)}\n`);
    for (const line of provisioningLines(header, state)) {
      process.stdout.write(`${line}\n`);
    }
    for (const id of state.order) {
      const node = state.nodes[id];
      if (node === undefined) continue;
      // Same word source as run/attach's plain face — STATUS_META's external
      // wording (ok→success, …), padded to 7, so a green node reads `success`
      // in every plain face. The `??` keeps the snapshot-only states whose
      // progress mapping is null (pending) reading as their raw status.
      const word = STATUS_META[node.status].progress ?? node.status;
      const owedMark =
        posting.owed.some((o) => o.context === id) ? yellow(" ⇐ github?") : "";
      process.stdout.write(
        `${statusGlyph(node.status)} ${word.padEnd(7)} ${id}${owedMark}\n`,
      );
    }
  }
  return exitCode(state);
}

export async function logsCommand(
  token: string,
  follow: boolean,
  socketPath?: string,
): Promise<number> {
  const { client, close } = await dialRunOrExit(socketPath);
  const state = await firstSnapshot(client);
  const id = resolveNodeId(state, token);
  const code = await logStream(client, id, follow);
  await close();
  return code;
}

/** One node's output onto stdout — the dial-free half of `logsCommand`, split
 *  out for the same reason `attachStream` is split out of `attachCommand`: the
 *  loop is what has a contract, and a contract wants a test that can end the
 *  feed on purpose.
 *
 *  Returns 0 only when the command got the WHOLE answer it promises — the log's
 *  `end` frame under `-f`, the buffered snapshot without it. */
export async function logStream(
  client: Pick<OduClient, "surface">,
  id: string,
  follow: boolean,
): Promise<number> {
  /** The frame that means this command has the whole answer — named ONCE, and
   *  used both to stop the loop and to judge how the loop stopped, so the two
   *  cannot drift apart when one is edited.
   *
   *  `end` means the node produced all the output it ever will, so `-f` has
   *  nothing left to follow — stop, rather than holding the terminal open until
   *  the whole run exits. Without it a `logs -f` on a finished node never
   *  returns, which is precisely the wait an agent cannot afford. Without `-f`
   *  the buffered snapshot IS the whole answer. */
  const isWholeAnswer = (frame: NodeLogFrame): boolean =>
    frame.kind === "end" || (!follow && frame.kind === "snapshot");

  let last: NodeLogFrame | undefined;
  await untilFeedDropped(async () => {
    for await (const frame of subscribe(client.surface.nodeLog.get({ id }))) {
      last = frame;
      // `end` carries no bytes.
      if (frame.kind !== "end") process.stdout.write(frame.text);
      if (isWholeAnswer(frame)) break;
    }
  });
  // Ending any OTHER way is the feed dying, and returning 0 there would hand
  // back a log that stops mid-line as a complete one — the single forbidden
  // outcome this repo already spent #88/#89 on ("either the log is complete, or
  // it says it isn't"), and it was reachable here by dropping a link.
  if (last !== undefined && isWholeAnswer(last)) return 0;
  process.stderr.write(
    feedDroppedMessage(follow ? `${id}'s log ended` : `${id}'s log arrived`),
  );
  return 1;
}

export async function attachCommand(json: boolean): Promise<number> {
  // The dashboard reads keystrokes (attach / rerun / quit), so it needs a TTY
  // *stdin* — the one deliberate threshold difference from `run`'s output-only
  // live matrix, which keys off stdout alone. The non-interactive fallback is
  // no longer a poor cousin: it shares `run`'s json/plain rendering
  // (juspay/odu#4), so a piped `attach` and a piped `run` emit one contract.
  const interactive =
    !json && process.stdin.isTTY === true && process.stdout.isTTY === true;
  const { client, close } = await dialRunOrExit();
  if (!interactive) return attachStream(client, close, json);
  return attachDashboard(client, close);
}

/** Run `pump` and swallow a dropped LINK — the two ways a watching face's feed
 *  can go away, brought onto one path.
 *
 *  A transport that dies mid-subscription arrives one of two shapes, and the
 *  faces used to treat them as different kinds of event: an interrupt-only
 *  `Cause` ends the iteration cleanly (`effectEdge`'s `endOnInterrupt`), while a
 *  tagged `SurfaceStdioTransportClosed` — the keep-alive death this whole change
 *  is about — REJECTED out of the `for await` and crashed the command with a
 *  framework sentence about stdio transports. So `odu attach` answered the
 *  polite death with `feedDroppedMessage` and the common one with a stack.
 *
 *  Swallowing it here is not losing the error: the caller's own terminal check
 *  runs next and finds it never got what it was waiting for, so the same
 *  dropped-feed line and the same exit code follow either way. Anything that is
 *  NOT a dead transport still propagates — this is a classifier, not a
 *  catch-all.
 *
 *  (`waitForSettle` deliberately does the opposite with the same error: it
 *  re-dials. Outliving a drop is its whole job; reporting one is theirs.) */
async function untilFeedDropped(pump: () => Promise<void>): Promise<void> {
  try {
    await pump();
  } catch (err) {
    if (!isDeadTransportError(err)) throw err;
  }
}

/** The exit code an attach face reports for the run it was WATCHING, and the
 *  one place either of them decides it.
 *
 *  Both faces end their loop two ways — the run settled, or the feed died under
 *  them — and both arrive as the same `done: true`. Reading the second as the
 *  first is how a piped `attach` came to exit 0 on a run still going:
 *  `exitCode` is 0 for anything that has not settled. Which one happened is
 *  ASKED OF THE STATE rather than remembered in a flag beside the loop —
 *  `summarize(last).done` IS each loop's break condition, so the question and
 *  the answer cannot drift apart when one is edited. (`lane.ts`'s pump states
 *  the same rule its own way: "lane state stream ended" → `die`.)
 *
 *  One function because it is one decision. Two copies of it is how the two
 *  faces would come to disagree about what a dropped feed means — which is the
 *  drift `odu wait` and `wait_for_settle` had, one layer over. */
function watchedRunExit(last: PipelineState | undefined): number {
  if (last !== undefined && summarize(last).done) return exitCode(last);
  process.stderr.write(feedDroppedMessage("this run settled"));
  return 1;
}

/** Non-tty / `-o json`: one line per node transition — the attach analogue
 *  of `--progress json`. Routes through `run`'s own `createDisplay`, building
 *  each event with the shared `progressEvent`, so the json shape (with
 *  `recipe`/`platform`/`log`), the plain line format, and the 60s heartbeat
 *  are byte-identical to `run` rather than a drifted re-implementation. */
export async function attachStream(
  // The `surface` slice only, exactly as `logStream` takes it: an attach face
  // reads members, it never needs the link handle beside them — and a narrow
  // parameter is what lets a test hand over a stub stream without pretending to
  // be a whole client.
  client: Pick<OduClient, "surface">,
  close: () => Promise<void>,
  json: boolean,
): Promise<number> {
  const display = createDisplay(json ? "json" : "plain");
  const seen = new Map<string, NodeState["status"]>();
  let last: PipelineState | undefined;
  let started = false;
  await untilFeedDropped(async () => {
    for await (const state of subscribe(client.surface.nodes.get(undefined))) {
      last = state;
      if (!started) {
        started = true;
        // Commit identity (pipeline name + sha) comes from the snapshot's state;
        // an observer has no run-env (no leased hosts, no forge origin, no own
        // start clock), so it never calls `setHeader` and the banner collapses
        // to `odu · <pipeline> @ <sha>`. The matrix dashboard follows the
        // surface `header` cell instead (see `attachDashboard`).
        display.start(state);
      }
      display.update(state); // drives the plain heartbeat
      for (const id of state.order) {
        const node = state.nodes[id];
        if (node === undefined || seen.get(id) === node.status) continue;
        seen.set(id, node.status);
        const event = progressEvent(state.sha7, id, node);
        if (event !== null) display.transition(event, node);
      }
      if (summarize(state).done) break;
    }
  });
  display.stop(last);
  await close();
  return watchedRunExit(last);
}

/** Interactive view — the ONE shared live view (`createDisplay("live", …)`),
 *  the same `run` paints, fed from the surface instead of the in-process run:
 *  state is push-fed from the `nodes` read-loop (`view.update`), the focused
 *  node's log is pull-fed via the surface `nodeLog` stream (`openLog`), and `r`
 *  routes to the surface `node.rerun`. The header (lane→host map) comes off the
 *  surface, so this is the same matrix, not a separate table. */
async function attachDashboard(
  client: OduClient,
  close: () => Promise<void>,
): Promise<number> {
  // The one binding for the latest state: both the completion path (`view.stop`,
  // the returned verdict) and the quit path read it. `attach` owns its own
  // exit-code policy (the view no longer carries it on `onQuit`): the current
  // verdict via the shared `exitCode` projection.
  let last: PipelineState | undefined;
  const quit = (code: number): void => {
    view.stop(last);
    // Fire-and-forget: the process is exiting, and the link teardown it just
    // issued needs no witness — awaiting it would park the exit behind a
    // protocol scope that may be waiting on the very socket we are leaving.
    void close();
    process.exit(code);
  };
  const view = createDisplay("live", {
    interactive: true,
    hookStderr: false,
    openLog: (id) => client.surface.nodeLog.get({ id }),
    // `runUnary`, not `void` — a unary verb is an Effect, and `void`ing one
    // DESCRIBES the rerun without ever dispatching it. That is exactly what this
    // line did after the first Effect wave: pressing `r` in the attached
    // dashboard silently did nothing, and nothing in the type system said so.
    // The rejection is swallowed deliberately (the view is fire-and-forget; a
    // failed rerun shows up as the node not moving), but it is swallowed from a
    // call that actually happened.
    rerun: (id) => {
      void runUnary(client.surface.node.rerun({ id })).catch(() => {});
    },
    onQuit: () => quit(exitCode(last)),
  });

  // Follow the header for the rest of the session — the ONE path by which this
  // face learns the run environment. `run` publishes it twice — once while it is
  // still claiming a machine, once with the resolved lane→host map
  // (juspay/odu#84) — so a dashboard attached during provisioning (exactly when
  // an operator reaches for one) would otherwise show the claiming line for the
  // whole run. The cell yields its current value first, so the display has the
  // real header before the first `nodes` frame starts the view.
  //
  // Held as a handle rather than left floating: it is a second timeline over the
  // same link, and the function must not return while it is still running. The
  // node loop below owns how the session ends; this one ends with the link.
  const headerLoop = (async () => {
    for await (const next of subscribe(client.surface.header.get(undefined))) {
      view.setHeader(next);
    }
  })().catch(() => {
    // The link went away with the run (or with `quit`) — nothing to report.
  });

  let first = true;
  await untilFeedDropped(async () => {
    for await (const state of subscribe(client.surface.nodes.get(undefined))) {
      last = state;
      if (first) {
        first = false;
        view.start(state);
      } else {
        view.update(state);
      }
      if (summarize(state).done) break;
    }
  });
  view.stop(last);
  // The viewport is gone; say how the run ended. `run` has its own verdict —
  // an observer would otherwise be left with only an exit code.
  if (last !== undefined) process.stdout.write(verdictLine(last));
  await close();
  // The subscription is torn down with the link, so this settles rather than
  // stranding a live `for await` past the function that opened it.
  await headerLoop;
  // After `view.stop`, so a dropped-feed line reaches an operator whose
  // terminal is back rather than one watching a frozen matrix.
  return watchedRunExit(last);
}

/** `odu cancel` — tell the live run in this checkout to stop, and wait until
 *  its coordinator is gone. No live run is a clean no-op (nothing to cancel),
 *  not an error: cancelling something already finished is success.
 *
 *  With a target (`ci::fmt@plat` or `@plat`), cancel only that node or
 *  platform lane and leave the rest of the run to settle (juspay/odu#68). */
export async function cancelCommand(
  target?: string,
  socketPath?: string,
): Promise<number> {
  // Present-but-empty positional is a usage error — never escalate to full-run
  // teardown (scripts with unset $TARGET must not kill the coordinator).
  if (target !== undefined) {
    if (target === "") {
      process.stderr.write(
        "odu: cancel needs a node id (ci::fmt@plat) or @platform, or no args for full-run cancel\n",
      );
      return 1;
    }
    const result = await cancelNodeOrPlatform(target, socketPath);
    if (result.kind === "bad_target") {
      process.stderr.write(
        `odu: not a node id or @platform: ${target}\n`,
      );
      return 1;
    }
    if (result.kind === "no_run") {
      process.stderr.write(
        "odu: no run in progress in this checkout (nothing to cancel)\n",
      );
      return 0;
    }
    if (!result.ok) {
      const detail =
        result.error !== undefined && result.error !== ""
          ? result.error
          : "unknown node/platform, or already terminal";
      process.stderr.write(`odu: could not cancel ${target} (${detail})\n`);
      return 1;
    }
    process.stdout.write(`odu: cancelled ${target}\n`);
    return 0;
  }

  const result = await cancelRun(socketPath);
  if (!result.cancelled) {
    process.stderr.write(
      "odu: no run in progress in this checkout (nothing to cancel)\n",
    );
    return 0;
  }
  process.stdout.write(
    result.confirmed
      ? "odu: run cancelled\n"
      : "odu: cancel requested — the coordinator is still shutting down\n",
  );
  return 0;
}

/** Loud "no run" message — same wording `dialRunOrExit` uses so a plain-CLI agent
 *  gets one recognizable refusal across every attach face. */
function noRunInProgress(path: string): void {
  process.stderr.write(noRunInProgressMessage(path));
}

export interface WaitCommandOpts {
  settle: boolean;
  timeoutMs?: number;
  expectedSha?: string;
  socketPath?: string;
}

/** `odu wait [--settle] [--timeout-ms N] [--expected-sha SHA]` — block on the
 *  live run's `nodes` stream and print one JSON verdict line. Default is
 *  fail-fast; `--settle` waits for the whole run. Exit 0 only on a fully-settled
 *  all-green run. Shares `waitForSettle` with the MCP `wait_for_settle` tool.
 *
 *  WHAT WENT WRONG, IN THE RIGHT ORDER — because the first version of this note
 *  had it backwards, and a wrong first-order cause is what the next debugger of
 *  this class would have started from.
 *
 *  The lie was the CORE's, and it belonged to both faces. `waitForSettle`
 *  answered a dead link as a finished run: one subscription, and a
 *  `SurfaceStdioTransportClosed` went straight to the end-of-stream verdict. A
 *  link dies under a perfectly healthy run all the time — the wire's keep-alive
 *  makes 5–10s of peer silence fatal, and a coordinator claiming a venue goes
 *  quiet for that long — so `{settled:false, passed:false}` came back about a
 *  run that was still going. MCP `wait_for_settle` calls that same function and
 *  would have said the same thing; the field observation of the two faces
 *  disagreeing is not evidence that they differed here.
 *
 *  What THIS command's reader added was not the lie but a trap. It dialled
 *  `.ci/odu.sock` here and handed the wait one already-opened link — a private,
 *  one-shot copy of what `mcp.ts` builds with `redialingAClient`, whose dial is
 *  a scoped acquire of the stream instead. So the fix the core needed
 *  (re-subscribe instead of answering) would have been silently INERT on the
 *  CLI: a fresh subscription to a captured link reaches the same corpse. Both
 *  changes are needed, and only one of them is the bug.
 *
 *  Hence `agentReaderForSocket` — the only exported way to build a reader over
 *  a live checkout, so the shape that disarms the repair cannot be written
 *  again. Not "one reader for both faces": `odu mcp` hands its handler the
 *  adapter's projected B-client, and what the two genuinely share is set out in
 *  that function's own doc.
 *
 *  Dialing moves INTO the wait as a consequence, and the no-run refusal moves
 *  with it: the reader answers its `{ run: false }` frame, the core raises
 *  `NoLiveRunError`, and the catch below prints the same one line to stderr and
 *  exits 1 that the eager dial did. */
export async function waitCommand(opts: WaitCommandOpts): Promise<number> {
  const socketPath = opts.socketPath ?? SOCKET_PATH;
  try {
    const verdict = await waitForSettle({
      client: agentReaderForSocket(socketPath),
      // CLI default = fail-fast; `--settle` opts out (failFast: false).
      failFast: !opts.settle,
      timeoutMs: opts.timeoutMs,
      expectedSha: opts.expectedSha,
      socketPath,
    });
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
    // Exit 0 only on a fully-settled clean pass — fail-fast red, timeout,
    // cancelled nodes, and partial settles are all non-zero.
    return verdict.settled && verdict.passed ? 0 : 1;
  } catch (err) {
    if (err instanceof NoLiveRunError) {
      process.stderr.write(`odu: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

/** Expand a rerun selector against live state into fan-in node ids:
 *  - `ci::unit@plat` — one node (exact id, or the unique `resolveNodeId` match)
 *  - `@plat` — recipe nodes on that platform lane (not `_ci-setup`)
 *  - `unit` / `ci::unit` — that recipe on every lane (multi-match is the point)
 *
 *  Mirrors `odu cancel`'s node / `@platform` sugar and adds the bare-recipe
 *  form cancel doesn't need (cancel has `lane.cancel`; rerun is only per-node). */
export function resolveRerunTargets(
  state: PipelineState,
  selector: string,
): string[] {
  const platform = parseAtPlatform(selector);
  if (platform !== null) {
    // Recipe nodes on the lane only — not `_ci-setup@plat` (see isSetupNode).
    const ids = state.order.filter(
      (id) => onPlatform(id, platform) && !isSetupNode(id),
    );
    if (ids.length === 0) {
      throw new Error(`odu: no nodes on platform "${platform}"`);
    }
    return ids;
  }
  if (selector.startsWith("@")) {
    throw new Error(
      `odu: not a node id, @platform, or recipe: ${selector}`,
    );
  }

  // Multi-match is intentional for recipe-wide rerun — not an ambiguity error.
  const matches = matchNodeIds(state, selector);
  if (matches.length === 0) {
    throw new Error(
      `odu: no node matches "${selector}" (try: ${state.order.join(", ")})`,
    );
  }
  return matches;
}

/** Collapse multi-target rerun to dependency-minimal roots so a dependent that
 *  is already in another selected root's transitive `needs` closure is not
 *  issued its own `node.rerun` (each call resets id + dependents via the same
 *  `transitiveDependents` rule the runner uses). Closures are computed once
 *  per target. */
export function minimalRerunRoots(
  state: PipelineState,
  targets: string[],
): string[] {
  const needsOf = (id: string): readonly string[] =>
    state.nodes[id]?.needs ?? [];
  const coveredBy = new Map<string, Set<string>>();
  for (const t of targets) {
    coveredBy.set(t, transitiveDependents(state.order, needsOf, t));
  }
  return targets.filter((id) => {
    for (const other of targets) {
      if (other === id) continue;
      if (coveredBy.get(other)?.has(id) === true) return false;
    }
    return true;
  });
}

/** Format `odu: reran …` including dependents the runner will also reset. */
export function formatReranLine(
  state: PipelineState,
  roots: string[],
): string {
  const needsOf = (id: string): readonly string[] =>
    state.nodes[id]?.needs ?? [];
  const parts = roots.map((root) => {
    const deps = [...transitiveDependents(state.order, needsOf, root)];
    return deps.length === 0
      ? root
      : `${root} (resets ${deps.join(", ")})`;
  });
  return `odu: reran ${parts.join("; ")}\n`;
}

/** `odu rerun <selector>` — headless face of surface `node.rerun`. Selector
 *  forms: one node, `@platform` (every node on that lane), or a recipe name
 *  (that recipe on every lane). Prints what was rerun; no socket / all
 *  `{ ok: false }` → loud error, non-zero exit. */
export async function rerunCommand(
  selector: string,
  socketPath: string = SOCKET_PATH,
): Promise<number> {
  if (selector === "") {
    process.stderr.write(
      "odu: rerun needs a node id (ci::fmt@plat), @platform, or recipe\n",
    );
    return 1;
  }
  const dialed = await dialRun(socketPath);
  if (dialed === null) {
    // A bare "no run in progress" over a killed run's residue is how the
    // incident hid it — the MCP `node_rerun` names the corpse; the CLI twin
    // answers the same sentence. (deadRun answers null while ANY coordinator
    // is live, so this never collides with a plain no-run refusal.)
    const dead = await deadRun(
      dirname(dirname(socketPath)),
      socketPath === SOCKET_PATH ? {} : { socketPath },
    );
    if (dead !== null) {
      process.stderr.write(
        `odu: ${describeDeadRun(dead)} There is no live run to rerun on — ` +
          "start a new one (starting over the residue works without `supersede`).\n",
      );
      return 1;
    }
    noRunInProgress(socketPath);
    return 1;
  }
  try {
    const state = await firstSnapshot(dialed.client);
    let targets: string[];
    try {
      targets = resolveRerunTargets(state, selector);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${msg}\n`);
      return 1;
    }
    // Collapse same-lane multi-id expansions so dependents aren't double-reset.
    const roots = minimalRerunRoots(state, targets);
    if (roots.length === 0) {
      process.stderr.write(
        `odu: no rerun roots after dependency collapse for ${selector}\n`,
      );
      return 1;
    }
    const ok: string[] = [];
    const failed: string[] = [];
    for (const id of roots) {
      // `runUnary` — a unary verb is an Effect, which is inert until it is run;
      // `await`ing the Effect itself would resolve to the description and never
      // send the rerun (see the same call in the live view above).
      const result = await runUnary(dialed.client.surface.node.rerun({ id }));
      if (result.ok) ok.push(id);
      else failed.push(id);
    }
    if (ok.length === 0) {
      process.stderr.write(
        `odu: could not rerun ${selector} (${failed.join(", ")}: unknown node, or its lane is gone)\n`,
      );
      return 1;
    }
    process.stdout.write(formatReranLine(state, ok));
    if (failed.length > 0) {
      process.stderr.write(
        `odu: failed to rerun ${failed.join(", ")} (unknown node, or its lane is gone)\n`,
      );
      return 1;
    }
    return 0;
  } finally {
    // `await` — the Effect link teardown is async now (it was a sync `close()`
    // under oRPC), so a bare call would let the CLI return before the socket
    // is actually released.
    await dialed.close();
  }
}
