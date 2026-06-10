/**
 * In-band introspection of a live run — `odu status` / `logs` / `attach`
 * attach to the coordinator's fan-in surface on `.ci/odu.sock`. The same
 * three primitives every face speaks: one snapshot of the `nodes` cell, a
 * log stream with snapshot-then-append replay, the dashboard with `r`erun.
 */

import {
  EMPTY_HEADER,
  type NodeState,
  type PipelineState,
  type RunHeader,
  STATUS_META,
} from "../common/surface";
import { createDisplay, progressEvent } from "../coordinator/display";
import { dialSocket, type OduClient } from "../coordinator/socket";
import { nodeRow, statusGlyph, summarize } from "./render";

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

/** Resolve a node argument against the live state: exact id, or unique
 *  suffix-ish match (`e2e@x86_64-linux` ≡ `ci::e2e@x86_64-linux`). */
export function resolveNodeId(state: PipelineState, token: string): string {
  if (state.nodes[token] !== undefined) return token;
  const matches = state.order.filter(
    (id) =>
      id === token || id.endsWith(`::${token}`) || id.includes(`::${token}@`),
  );
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
  if (json) {
    const rows = state.order
      .map((id) => state.nodes[id])
      .filter((n): n is NonNullable<typeof n> => n !== undefined)
      .map(nodeRow);
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  } else {
    for (const id of state.order) {
      const node = state.nodes[id];
      if (node === undefined) continue;
      // Same word source as run/attach's plain face — STATUS_META's external
      // wording (ok→success, …), padded to 7, so a green node reads `success`
      // in every plain face. The `??` keeps the snapshot-only states whose
      // progress mapping is null (pending) reading as their raw status.
      const word = STATUS_META[node.status].progress ?? node.status;
      process.stdout.write(
        `${statusGlyph(node.status)} ${word.padEnd(7)} ${id}\n`,
      );
    }
  }
  return summarize(state).failedOverall ? 1 : 0;
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
  return last !== undefined && summarize(last).failedOverall ? 1 : 0;
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
  let currentState: PipelineState | undefined;
  const quit = (code: number): void => {
    view.stop(currentState);
    close();
    process.exit(code);
  };
  const view = createDisplay("live", {
    interactive: true,
    hookStderr: false,
    openLog: (id, sig) => client.surface.nodeLog.get({ id }, { signal: sig }),
    rerun: (id) => void client.surface.node.rerun({ id }),
    onQuit: (code) => quit(code),
  });

  let last: PipelineState | undefined;
  let first = true;
  for await (const state of await client.surface.nodes.get({})) {
    last = state;
    currentState = state;
    if (first) {
      first = false;
      view.start(state, header);
    } else {
      view.update(state);
    }
    if (summarize(state).done) break;
  }
  view.stop(last);
  close();
  return last !== undefined && summarize(last).failedOverall ? 1 : 0;
}
