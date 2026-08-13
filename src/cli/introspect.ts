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

import { firstFrame, runUnary, subscribe } from "../common/effectEdge";
import {
  EMPTY_HEADER,
  type NodeState,
  type PipelineState,
  postingOf,
  type RunHeader,
  type RunPhase,
  runPhase,
  STATUS_META,
} from "../common/surface";
import { formatGoDuration } from "../common/duration";
import {
  onPlatform,
  parseAtPlatform,
  SETUP_NAMEPATH,
  splitFanId,
  transitiveDependents,
} from "../common/nodeId";
import { cancelNodeOrPlatform, cancelRun } from "../coordinator/cancel";
import { createDisplay, progressEvent } from "../coordinator/display";
import {
  dialSocket,
  noRunInProgressMessage,
  type OduClient,
  SOCKET_PATH,
  tryDialSocket,
} from "../coordinator/socket";
import { postingWarning } from "../coordinator/statuses";
import {
  NoLiveRunError,
  waitForSettle,
} from "../coordinator/waitForSettle";
import { agentReaderFromA } from "../mcp/agentSurface";
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

/** The run header off the surface, AS OF DIAL TIME. The `header` cell always
 *  yields its current value, so an empty stream means the coordinator closed
 *  before sending — a protocol failure we surface rather than mask with a blank
 *  banner (mirrors `firstSnapshot`).
 *
 *  It is NOT the run's final lane→host map. `run` serves the socket before it
 *  claims a machine (juspay/odu#84) and publishes the header twice — once while
 *  claiming, once resolved — so a reader that dials during provisioning gets a
 *  header with empty `lanes`. One-shot readers (`odu status`) want exactly
 *  that: the environment as it stands right now. Anything that lives longer
 *  than one snapshot must SUBSCRIBE to `client.surface.header.get(undefined)`
 *  instead — see `attachDashboard`, which follows the cell for its lane line. */
export async function firstHeader(client: OduClient): Promise<RunHeader> {
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

/** The run-environment block `odu status` prints above the node rows while a
 *  run is still PROVISIONING — which host(s) each lane is claiming and how long
 *  it has been at it (juspay/odu#84). Nothing once every lane has a machine: the
 *  node rows are the run's state then, and a run that reached its lanes keeps
 *  the output it has always had. */
export function provisioningLines(
  header: RunHeader,
  nowMs = Date.now(),
): string[] {
  if (runPhase(header) !== "provisioning") return [];
  const elapsed =
    header.startedAt > 0 ? ` ${formatGoDuration(nowMs - header.startedAt)}` : "";
  const lines = [`provisioning${elapsed}`];
  const claiming = claimingText(header);
  if (claiming !== "") lines.push(`  claiming ${claiming}`);
  // A partly-claimed multi-platform run: the lanes that already have a machine.
  const lanes = laneText(header);
  if (lanes !== "") lines.push(`  lanes ${lanes}`);
  return lines;
}

/** The machine-readable run environment on `odu status -o json`. Additive: the
 *  `nodes` / `posting` keys older readers use are untouched. `elapsed_ms` is
 *  null only for a header no run ever published. */
export function runEnvJson(
  header: RunHeader,
  nowMs = Date.now(),
): {
  phase: RunPhase;
  elapsed_ms: number | null;
  lanes: { platform: string; host: string }[];
  claiming: { platform: string; pool: string[] }[];
} {
  return {
    phase: runPhase(header),
    elapsed_ms: header.startedAt > 0 ? nowMs - header.startedAt : null,
    lanes: header.lanes.map((l) => ({ platform: l.platform, host: l.host })),
    claiming: header.claiming.map((c) => ({
      platform: c.platform,
      pool: [...c.pool],
    })),
  };
}

export async function statusCommand(
  json: boolean,
  socketPath?: string,
): Promise<number> {
  const { client, close } = await dialSocket(socketPath);
  const state = await firstSnapshot(client);
  // The run environment, read from the same dial: a run that has no lanes yet
  // has nothing to say through `nodes` alone, and "no rows" is exactly the
  // ambiguity juspay/odu#84 is about.
  const header = await firstHeader(client);
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
    for (const line of provisioningLines(header)) {
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
): Promise<number> {
  const { client, close } = await dialSocket();
  const state = await firstSnapshot(client);
  const id = resolveNodeId(state, token);
  for await (const frame of subscribe(client.surface.nodeLog.get({ id }))) {
    process.stdout.write(frame.text);
    if (!follow && frame.kind === "snapshot") break;
  }
  await close();
  return 0;
}

export async function attachCommand(json: boolean): Promise<number> {
  // The dashboard reads keystrokes (attach / rerun / quit), so it needs a TTY
  // *stdin* — the one deliberate threshold difference from `run`'s output-only
  // live matrix, which keys off stdout alone. The non-interactive fallback is
  // no longer a poor cousin: it shares `run`'s json/plain rendering
  // (juspay/odu#4), so a piped `attach` and a piped `run` emit one contract.
  const interactive =
    !json && process.stdin.isTTY === true && process.stdout.isTTY === true;
  const { client, close } = await dialSocket();
  if (!interactive) return attachStream(client, close, json);
  return attachDashboard(client, close);
}

/** Non-tty / `-o json`: one line per node transition — the attach analogue
 *  of `--progress json`. Routes through `run`'s own `createDisplay`, building
 *  each event with the shared `progressEvent`, so the json shape (with
 *  `recipe`/`platform`/`log`), the plain line format, and the 60s heartbeat
 *  are byte-identical to `run` rather than a drifted re-implementation. */
export async function attachStream(
  client: OduClient,
  close: () => Promise<void>,
  json: boolean,
): Promise<number> {
  const display = createDisplay(json ? "json" : "plain");
  const seen = new Map<string, NodeState["status"]>();
  let last: PipelineState | undefined;
  let started = false;
  for await (const state of subscribe(client.surface.nodes.get(undefined))) {
    last = state;
    if (!started) {
      started = true;
      // Commit identity (pipeline name + sha) comes from the snapshot's state;
      // an observer has no run-env (no leased hosts, no forge origin, no own
      // start clock), so it passes EMPTY_HEADER and the banner collapses to
      // `odu · <pipeline> @ <sha>`. The matrix dashboard reads the real
      // run-env off the surface `header` cell instead (`firstHeader`).
      display.start(state, EMPTY_HEADER);
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
  display.stop(last);
  await close();
  return exitCode(last);
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
  const header = await firstHeader(client);
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

  // Follow the header for the rest of the session. `run` publishes it twice —
  // once while it is still claiming a machine, once with the resolved lane→host
  // map (juspay/odu#84) — so a dashboard attached during provisioning (exactly
  // when an operator reaches for one) would otherwise show the claiming line for
  // the whole run. The cell yields its current value first, so re-applying the
  // header we already have is a no-op, not a flicker. Ends when the link closes
  // with the dashboard.
  void (async () => {
    try {
      for await (const next of subscribe(client.surface.header.get(undefined))) {
        view.setHeader(next);
      }
    } catch {
      // The link went away with the run (or with `quit`) — nothing to report:
      // the node stream below owns how this session ends.
    }
  })();

  let first = true;
  for await (const state of subscribe(client.surface.nodes.get(undefined))) {
    last = state;
    if (first) {
      first = false;
      view.start(state, header);
    } else {
      view.update(state);
    }
    if (summarize(state).done) break;
  }
  view.stop(last);
  // The viewport is gone; say how the run ended. `run` has its own verdict —
  // an observer would otherwise be left with only an exit code.
  if (last !== undefined) process.stdout.write(verdictLine(last));
  await close();
  return exitCode(last);
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

/** Loud "no run" message — same wording `dialSocket` uses so a plain-CLI agent
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
 *  all-green run. Shares `waitForSettle` with the MCP `wait_for_settle` tool. */
export async function waitCommand(opts: WaitCommandOpts): Promise<number> {
  const socketPath = opts.socketPath ?? SOCKET_PATH;
  const dialed = await tryDialSocket(socketPath);
  if (dialed === null) {
    noRunInProgress(socketPath);
    return 1;
  }
  try {
    const verdict = await waitForSettle({
      client: agentReaderFromA(dialed.client),
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
  } finally {
    // `await` — the Effect link teardown is async now (it was a sync `close()`
    // under oRPC), so a bare call would let the CLI return before the socket
    // is actually released.
    await dialed.close();
  }
}

/** Fan-in bookkeeping node the coordinator owns — every task's `needs` includes
 *  `_ci-setup@plat`, so including it in `@platform` expansion would collapse
 *  multi-rerun to "re-provision the lane only". Explicit id still works. */
function isSetupNode(id: string): boolean {
  return splitFanId(id).namepath === SETUP_NAMEPATH;
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
  const dialed = await tryDialSocket(socketPath);
  if (dialed === null) {
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
