/**
 * Pure rendering + state-derivation helpers for `odu attach` (and the unit
 * tests). Everything is a pure function of surface state — no I/O, no
 * terminal control. Ported from the mini-ci example TUI, with the `errored`
 * status and CI-sized node ids.
 */

import {
  clampLog,
  type NodeState,
  type PipelineState,
  STATUS_META,
} from "../common/surface";
import { dim, green, magenta, red, yellow } from "./ansi";

/** Per-status colour, shared by every face (attach table, run matrix,
 *  verdict) — a no-op when stdout isn't a TTY, so pure-string tests and
 *  captured logs see the bare glyphs. */
export const STATUS_COLOR: Record<NodeState["status"], (s: string) => string> =
  {
    pending: dim,
    running: yellow,
    ok: green,
    failed: red,
    skipped: dim,
    errored: magenta,
  };

/** The status glyph, coloured for terminals. */
export function statusGlyph(status: NodeState["status"]): string {
  return STATUS_COLOR[status](STATUS_META[status].glyph);
}

export interface PipelineSummary {
  running: number;
  ok: number;
  failed: number;
  skipped: number;
  errored: number;
  pending: number;
  /** No node is pending or running — the pipeline has settled. */
  done: boolean;
  /** Settled with at least one failure or infrastructure error. */
  failedOverall: boolean;
}

/** The machine-readable snapshot of one node — the snake_cased projection
 *  shared by `odu status -o json` and the MCP `get_nodes` tool, so the two
 *  agent/tooling faces speak one vocabulary (both `id` and `name`) instead of
 *  re-deriving it inline and drifting. `get_nodes` spreads this and adds the
 *  `red` verdict bit on top. */
export interface NodeRowJson {
  id: string;
  name: string;
  status: NodeState["status"];
  exit_code: number | null;
  duration_ms: number | null;
}

export function nodeRow(node: NodeState): NodeRowJson {
  return {
    id: node.id,
    name: node.name,
    status: node.status,
    exit_code: node.exitCode,
    duration_ms: node.durationMs,
  };
}

export function summarize(state: PipelineState): PipelineSummary {
  const counts = {
    running: 0,
    ok: 0,
    failed: 0,
    skipped: 0,
    errored: 0,
    pending: 0,
  };
  for (const id of state.order) {
    const node = state.nodes[id];
    if (node === undefined) continue;
    counts[node.status] += 1;
  }
  const done = counts.pending === 0 && counts.running === 0;
  return {
    ...counts,
    done,
    failedOverall: done && counts.failed + counts.errored > 0,
  };
}

/** The default node to attach to: the first running node, else the first
 *  non-terminal node, else the last node. */
export function defaultAttachId(state: PipelineState): string | undefined {
  const running = state.order.find(
    (id) => state.nodes[id]?.status === "running",
  );
  if (running !== undefined) return running;
  const pending = state.order.find(
    (id) => state.nodes[id]?.status === "pending",
  );
  if (pending !== undefined) return pending;
  return state.order.at(-1);
}

/** Keep a log buffer in sync with a stream of `nodeLog` frames — reset on a
 *  `snapshot` frame, append on a delta. Returns the new buffer. */
export function applyLogFrame(
  buffer: string,
  frame: { kind: "snapshot" | "append"; text: string },
): string {
  return clampLog(frame.kind === "snapshot" ? frame.text : buffer + frame.text);
}

/** The focused node's log pane — the bottom half of `attach`'s view, below the
 *  matrix: a rule, the node's command, then the last `logRows` lines of its
 *  captured output. `logRows` bounds how much of a long log we paint. */
export function renderLogPane(
  node: NodeState | undefined,
  log: string,
  logRows = 12,
): string {
  const rule = "─".repeat(60);
  if (node === undefined) return rule;
  const tail = log.split("\n").slice(-logRows).join("\n");
  return `${rule}\n$ ${node.command}\n${tail}`;
}
