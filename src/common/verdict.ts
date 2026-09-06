/**
 * What a run's state MEANS — settled or not, clean or not, and how it turned
 * out. The domain half of what used to be `src/cli/render.ts`.
 *
 * The split it makes is between a CLASSIFICATION and a RENDERING, and it is
 * load-bearing rather than tidy. "Is this run done" and "did it pass" are
 * facts the engine acts on: the verdict gate holds against them, the
 * coordinator's exit code is one of them, the settle wait answers with them.
 * They had no business living beside a glyph table — and while they did, the
 * engine imported the terminal face to ask what its own state meant, which is
 * an arrow pointing exactly the wrong way and the reason a service face could
 * not be built over the engine without dragging a TUI along.
 *
 * Everything here is pure and medium-free. No ansi, no colour, no cell
 * attributes; `render.ts` keeps those and reads its answers from here, so the
 * live matrix, the plain summary and an agent's verdict cannot disagree about
 * what a run contains.
 */

import {
  type NodeState,
  type NodeStatus,
  type PipelineState,
  STATUS_META,
} from "@odu/run-client/surface";

/** The non-terminal statuses: a node in one of these is still in flight, so the
 *  pipeline hasn't settled. The single taxonomy `summarize` (PipelineState) and
 *  `agentSummary` (agent rows) share for the "settled" concept, so the two
 *  faces can't disagree on done-ness — and adding a `NodeStatus` forces a
 *  decision here rather than silently defaulting to "terminal". */
export const NON_TERMINAL_STATUSES = new Set<NodeStatus>(["pending", "running"]);

export interface PipelineSummary {
  pending: number;
  running: number;
  ok: number;
  failed: number;
  skipped: number;
  errored: number;
  cancelled: number;
  /** Every node reached a terminal status. */
  done: boolean;
  /** Settled with at least one red node. */
  failedOverall: boolean;
  /** Settled, no red node, and nothing operator-cancelled. */
  clean: boolean;
}

export function summarize(state: PipelineState): PipelineSummary {
  const counts = {
    running: 0,
    ok: 0,
    failed: 0,
    skipped: 0,
    errored: 0,
    pending: 0,
    cancelled: 0,
  };
  for (const id of state.order) {
    const node = state.nodes[id];
    if (node === undefined) continue;
    counts[node.status] += 1;
  }
  const done = ![...NON_TERMINAL_STATUSES].some((s) => counts[s] > 0);
  const red = counts.failed + counts.errored > 0;
  return {
    ...counts,
    done,
    failedOverall: done && red,
    clean: done && !red && counts.cancelled === 0,
  };
}

/** The verdict-on-state projection every consumer reuses: 1 if the latest
 *  state has settled and is not a clean pass (red *or* cancelled), else 0.
 *  `undefined` (no state yet) is a clean 0. Folds the inline check so the live
 *  view and the attach faces compute the exit code one way (juspay/odu#68). */
export function exitCode(state: PipelineState | undefined): number {
  if (state === undefined) return 0;
  const s = summarize(state);
  return s.done && !s.clean ? 1 : 0;
}

/** The status buckets a counts line can show, in the order every face shows
 *  them. */
export const COUNT_KEYS = [
  "ok",
  "running",
  "pending",
  "failed",
  "errored",
  "cancelled",
  "skipped",
] as const satisfies readonly NodeStatus[];

/** `3 ok · 1 failed` — the counts line every face shows, so adding a
 *  `NodeStatus` cannot land in two of three renderings. Empty buckets are
 *  dropped; `which` narrows the set for a face with no room for all of them.
 *  This was three hand-rolled folds, and they had already drifted: the live
 *  status bar omitted `cancelled` entirely, so a cancelled lane had no in-frame
 *  readout at all (juspay/odu#68, #69). */
export function countsParts(
  s: PipelineSummary,
  which: readonly NodeStatus[] = COUNT_KEYS,
  keepZeros = false,
): { status: NodeStatus; text: string }[] {
  return which
    .filter((k) => keepZeros || s[k] > 0)
    .map((k) => ({ status: k, text: `${s[k]} ${k}` }));
}

/** The counts row as one string. The live face renders `countsParts` instead,
 *  so each bucket can carry its own status hue — but both read the same list,
 *  in the same order, so the two faces cannot drift on what a run contains.
 *
 *  @param keepZeros keep buckets that are zero — see `VERDICT_BUCKETS` in
 *  `coordinator/run` for why its caller wants them and the live faces do not. */
export function countsLine(
  s: PipelineSummary,
  which: readonly NodeStatus[] = COUNT_KEYS,
  keepZeros = false,
): string {
  return countsParts(s, which, keepZeros)
    .map((part) => part.text)
    .join(" · ");
}

/** How a settled run turned out. Three-way since juspay/odu#68: a run whose
 *  only non-ok nodes were cancelled is neither a pass nor a failure, and
 *  `exitCode` already returns 1 for it. */
export type Outcome = "pending" | "ok" | "incomplete" | "failed";

export function outcomeOf(s: PipelineSummary): Outcome {
  if (!s.done) return "pending";
  if (s.failedOverall) return "failed";
  return s.clean ? "ok" : "incomplete";
}

// ── node row projections ────────────────────────────────────────────────────

/** One node as an agent/JSON row. Snake_case because it crosses to MCP and to
 *  `status -o json`; `red` is the single source of "does this count against
 *  the verdict", read off `STATUS_META` rather than re-listed per consumer. */
export interface NodeRowJson {
  id: string;
  name: string;
  status: string;
  exit_code: number | null;
  duration_ms: number | null;
}

export function nodeRow(node: NodeState): NodeRowJson {
  return {
    id: node.id,
    name: node.name,
    status: node.status,
    exit_code: node.exitCode,
    duration_ms: node.durationMs === null ? null : Math.round(node.durationMs),
  };
}

export interface NodeRow extends NodeRowJson {
  red: boolean;
}

export function nodeRowRed(node: NodeState): NodeRow {
  return { ...nodeRow(node), red: STATUS_META[node.status].isRed };
}

export function rowsOf(state: PipelineState): NodeRow[] {
  return state.order
    .map((id) => state.nodes[id])
    .filter((n): n is NodeState => n !== undefined)
    .map(nodeRowRed);
}

/**
 * The agent-face parallel of `summarize`, over flattened rows.
 *
 * Takes the ROW SHAPE structurally rather than naming the MCP projection's
 * type: the classification is the domain's, and importing `AgentNodes` to
 * express it would make the engine depend on the agent face to ask what its
 * own rows mean — the same arrow this module exists to remove, one layer over.
 * `AgentNodes` satisfies it, so the call sites are unchanged.
 *
 * `done` when no row holds a non-terminal status (the same
 * `NON_TERMINAL_STATUSES` taxonomy `summarize` uses), and the red rows bucketed
 * using each row's own `red` bit (the single source of redness, so the agent
 * verdict can't drift from the TUI/run verdict).
 */
export function agentSummary(snap: {
  nodes: readonly { id: string; status: string; red: boolean }[];
}): {
  done: boolean;
  failed: string[];
  errored: string[];
  cancelled: string[];
} {
  const failed: string[] = [];
  const errored: string[] = [];
  const cancelled: string[] = [];
  let done = true;
  for (const node of snap.nodes) {
    if (NON_TERMINAL_STATUSES.has(node.status as NodeStatus)) done = false;
    if (node.status === "cancelled") cancelled.push(node.id);
    if (!node.red) continue;
    if (node.status === "failed") failed.push(node.id);
    else if (node.status === "errored") errored.push(node.id);
  }
  return { done, failed, errored, cancelled };
}
