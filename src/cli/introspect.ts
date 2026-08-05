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
  EMPTY_HEADER,
  type NodeState,
  type PipelineState,
  postingOf,
  type RunHeader,
  STATUS_META,
} from "../common/surface";
import { onPlatform, parseAtPlatform, splitFanId } from "../common/nodeId";
import { cancelNodeOrPlatform, cancelRun } from "../coordinator/cancel";
import { createDisplay, progressEvent } from "../coordinator/display";
import {
  dialSocket,
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
  exitCode,
  nodeRow,
  statusGlyph,
  summarize,
  verdictLine,
} from "./render";

export async function firstSnapshot(client: OduClient): Promise<PipelineState> {
  for await (const state of await client.surface.nodes.get({})) {
    return state;
  }
  throw new Error("odu: coordinator closed before sending state");
}

/** The run header off the surface — `run` publishes it before serving, so the
 *  first value is the real lane→host map. The `header` cell always yields its
 *  current value (EMPTY_HEADER until `run` publishes), so an empty stream means
 *  the coordinator closed before sending — a protocol failure we surface
 *  rather than mask with a blank banner (mirrors `firstSnapshot`). */
export async function firstHeader(client: OduClient): Promise<RunHeader> {
  for await (const header of await client.surface.header.get({})) {
    return header;
  }
  throw new Error("odu: coordinator closed before sending header");
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

export async function statusCommand(
  json: boolean,
  socketPath?: string,
): Promise<number> {
  const { client, close } = await dialSocket(socketPath);
  const state = await firstSnapshot(client);
  close();
  const posting = postingOf(state);
  if (json) {
    const rows = state.order
      .map((id) => state.nodes[id])
      .filter((n): n is NonNullable<typeof n> => n !== undefined)
      .map(nodeRow);
    // Object form carries posting health verbatim (juspay/odu#61); older
    // clients that expected a bare array should read `.nodes`.
    process.stdout.write(
      `${JSON.stringify({ nodes: rows, posting }, null, 2)}\n`,
    );
  } else {
    const warn = postingWarning(posting);
    if (warn !== null) process.stderr.write(`${yellow(warn)}\n`);
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
  for await (const frame of await client.surface.nodeLog.get({ id })) {
    process.stdout.write(frame.text);
    if (!follow && frame.kind === "snapshot") break;
  }
  close();
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
  close: () => void,
  json: boolean,
): Promise<number> {
  const display = createDisplay(json ? "json" : "plain");
  const seen = new Map<string, NodeState["status"]>();
  let last: PipelineState | undefined;
  let started = false;
  for await (const state of await client.surface.nodes.get({})) {
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
  close();
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
  close: () => void,
): Promise<number> {
  const header = await firstHeader(client);
  // The one binding for the latest state: both the completion path (`view.stop`,
  // the returned verdict) and the quit path read it. `attach` owns its own
  // exit-code policy (the view no longer carries it on `onQuit`): the current
  // verdict via the shared `exitCode` projection.
  let last: PipelineState | undefined;
  const quit = (code: number): void => {
    view.stop(last);
    close();
    process.exit(code);
  };
  const view = createDisplay("live", {
    interactive: true,
    hookStderr: false,
    openLog: (id, sig) => client.surface.nodeLog.get({ id }, { signal: sig }),
    rerun: (id) => void client.surface.node.rerun({ id }),
    onQuit: () => quit(exitCode(last)),
  });

  let first = true;
  for await (const state of await client.surface.nodes.get({})) {
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
  close();
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

/** Loud "no run" message — same wording `odu status` / `dialSocket` use so a
 *  plain-CLI agent gets one recognizable refusal across every attach face. */
function noRunInProgress(path: string): void {
  process.stderr.write(
    `odu: no run in progress in this checkout (no live socket at ${path})\n`,
  );
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
    dialed.close();
  }
}

/** Expand a rerun selector against live state into fan-in node ids:
 *  - `ci::unit@plat` — one node (exact id, or the unique `resolveNodeId` match)
 *  - `@plat` — every node on that platform lane
 *  - `unit` / `ci::unit` — that recipe on every lane (multi-match is the point)
 *
 *  Mirrors `odu cancel`'s node / `@platform` sugar and adds the bare-recipe
 *  form cancel doesn't need (cancel has `lane.cancel`; rerun is only per-node). */
/** Fan-in bookkeeping node the coordinator owns — every task's `needs` includes
 *  `_ci-setup@plat`, so including it in `@platform` expansion would collapse
 *  multi-rerun to "re-provision the lane only". Explicit id still works. */
function isSetupNode(id: string): boolean {
  return splitFanId(id).namepath === "_ci-setup";
}

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
 *  issued its own `node.rerun` (each call resets id + dependents). Closures
 *  are computed once per target (CI pipelines are small; still O(t·n²) not
 *  O(t²·n²)). */
export function minimalRerunRoots(
  state: PipelineState,
  targets: string[],
): string[] {
  const dependentsOf = (root: string): Set<string> => {
    const out = new Set<string>([root]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const id of state.order) {
        if (out.has(id)) continue;
        const needs = state.nodes[id]?.needs ?? [];
        if (needs.some((d) => out.has(d))) {
          out.add(id);
          grew = true;
        }
      }
    }
    out.delete(root);
    return out;
  };
  const coveredBy = new Map<string, Set<string>>();
  for (const t of targets) coveredBy.set(t, dependentsOf(t));
  return targets.filter((id) => {
    for (const other of targets) {
      if (other === id) continue;
      if (coveredBy.get(other)?.has(id) === true) return false;
    }
    return true;
  });
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
      process.stderr.write(`${(err as Error).message}\n`);
      return 1;
    }
    // Collapse same-lane multi-id expansions so dependents aren't double-reset.
    const roots = minimalRerunRoots(state, targets);
    const ok: string[] = [];
    const failed: string[] = [];
    for (const id of roots) {
      const result = await dialed.client.surface.node.rerun({ id });
      if (result.ok) ok.push(id);
      else failed.push(id);
    }
    if (ok.length === 0) {
      process.stderr.write(
        `odu: could not rerun ${selector} ({ ok: false } for ${failed.join(", ")})\n`,
      );
      return 1;
    }
    process.stdout.write(`odu: reran ${ok.join(", ")}\n`);
    if (failed.length > 0) {
      process.stderr.write(
        `odu: failed to rerun ${failed.join(", ")}\n`,
      );
      return 1;
    }
    return 0;
  } finally {
    dialed.close();
  }
}
