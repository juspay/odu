/**
 * In-band introspection of a live run — `odu status` / `logs` / `monitor`
 * attach to the coordinator's fan-in surface on `.ci/odu.sock`. The same
 * three primitives every face speaks: one snapshot of the `nodes` cell, a
 * log stream with snapshot-then-append replay, the dashboard with `r`erun.
 */

import type { NodeLogFrame, PipelineState } from "../common/surface";
import {
  createDisplay,
  progressEvent,
  type RunHeader,
} from "../coordinator/display";
import { dialSocket, type OduClient } from "../coordinator/socket";
import {
  applyLogFrame,
  defaultAttachId,
  nodeRow,
  renderDashboard,
  statusGlyph,
  summarize,
} from "./render";

export async function firstSnapshot(client: OduClient): Promise<PipelineState> {
  for await (const state of await client.surface.nodes.get({})) {
    return state;
  }
  throw new Error("odu: coordinator closed before sending state");
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

export async function statusCommand(json: boolean): Promise<number> {
  const { client, close } = await dialSocket();
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
      process.stdout.write(
        `${statusGlyph(node.status)} ${node.status.padEnd(8)} ${id}\n`,
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

export async function monitorCommand(json: boolean): Promise<number> {
  // The dashboard reads keystrokes (attach / rerun / quit), so it needs a TTY
  // *stdin* — the one deliberate threshold difference from `run`'s output-only
  // live matrix, which keys off stdout alone. The non-interactive fallback is
  // no longer a poor cousin: it shares `run`'s json/plain rendering
  // (juspay/odu#4), so a piped `monitor` and a piped `run` emit one contract.
  const interactive =
    !json && process.stdin.isTTY === true && process.stdout.isTTY === true;
  const { client, close } = await dialSocket();
  if (!interactive) return monitorStream(client, close, json);
  return monitorDashboard(client, close);
}

/** The run header `monitor` shows above the transition stream — `run`'s
 *  banner minus the parts only the coordinator owns. An attached observer
 *  knows the pipeline name + commit (from the surface) but not which hosts the
 *  coordinator leased (lanes) nor the forge origin (commitUrl), so it leaves
 *  those empty and the banner collapses to `odu · <pipeline> @ <sha>`. */
function monitorHeader(state: PipelineState): RunHeader {
  return {
    pipeline: state.name,
    sha7: state.sha7,
    dirty: state.dirty,
    commitUrl: null,
    lanes: [],
    hostsSource: null,
  };
}

/** Non-tty / `-o json`: one line per node transition — the monitor analogue
 *  of `--progress json`. Routes through `run`'s own `createDisplay`, building
 *  each event with the shared `progressEvent`, so the json shape (with
 *  `recipe`/`platform`/`log`), the plain line format, and the 60s heartbeat
 *  are byte-identical to `run` rather than a drifted re-implementation. */
export async function monitorStream(
  client: OduClient,
  close: () => void,
  json: boolean,
): Promise<number> {
  const display = createDisplay(json ? "json" : "plain");
  const seen = new Map<string, string>();
  let last: PipelineState | undefined;
  let started = false;
  for await (const state of await client.surface.nodes.get({})) {
    last = state;
    if (!started) {
      started = true;
      display.start(monitorHeader(state));
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

/** Interactive dashboard — node table + attached log pane.
 *  Keys: digits attach, n/p cycle, r rerun (the one mutation), q quit. */
async function monitorDashboard(
  client: OduClient,
  close: () => void,
): Promise<number> {
  let state: PipelineState | undefined;
  let attachedId: string | undefined;
  let log = "";
  let detachLog: (() => void) | undefined;

  const repaint = (): void => {
    if (state === undefined) return;
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(`${renderDashboard({ state, attachedId, log })}\n`);
    process.stdout.write(
      "\n[digits] attach · [n/p] cycle · [r] rerun · [q] quit\n",
    );
  };

  const attachLog = (id: string): (() => void) => {
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const frame of await client.surface.nodeLog.get(
          { id },
          { signal: controller.signal },
        )) {
          log = applyLogFrame(log, frame as NodeLogFrame);
          repaint();
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        log += `\n[odu] log stream error: ${(err as Error).message}\n`;
        repaint();
      }
    })();
    return () => controller.abort();
  };

  const attach = (id: string | undefined): void => {
    if (id === undefined || id === attachedId) return;
    attachedId = id;
    log = "";
    detachLog?.();
    detachLog = attachLog(id);
    repaint();
  };

  const quit = (code: number): void => {
    detachLog?.();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    close();
    process.exit(code);
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (key: string) => {
    if (key === "q" || key === "\x03" || key === "\x04") return quit(0);
    if (key === "r" && attachedId !== undefined) {
      void client.surface.node.rerun({ id: attachedId });
      return;
    }
    if (state === undefined) return;
    if (key === "n" || key === "p") {
      const idx =
        attachedId !== undefined ? state.order.indexOf(attachedId) : -1;
      const delta = key === "n" ? 1 : -1;
      attach(
        state.order[(idx + delta + state.order.length) % state.order.length],
      );
      return;
    }
    if (key >= "1" && key <= "9") {
      const next = state.order[Number(key) - 1];
      if (next !== undefined) attach(next);
    }
  });

  let first = true;
  for await (const next of await client.surface.nodes.get({})) {
    if (first) {
      first = false;
      attach(defaultAttachId(next));
    }
    state = next;
    repaint();
  }
  quit(state !== undefined && summarize(state).failedOverall ? 1 : 0);
  return 0;
}
