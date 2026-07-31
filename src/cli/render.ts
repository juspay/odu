/**
 * Pure rendering + state-derivation helpers for `odu attach` (and the unit
 * tests). Everything is a pure function of surface state — no I/O, no
 * terminal control. Ported from the mini-ci example TUI, with the `errored`
 * status and CI-sized node ids.
 */

import type { AgentNodes } from "../mcp/agentSurface";
import {
  type NodeState,
  type NodeStatus,
  type PipelineState,
  STATUS_META,
  type StatusHue,
} from "../common/surface";
import { fanId, splitFanId } from "../common/nodeId";
import { dim, green, magenta, red, stripAnsi, yellow } from "./ansi";

/** The non-terminal statuses: a node in one of these is still in flight, so the
 *  pipeline hasn't settled. The single taxonomy `summarize` (PipelineState) and
 *  `agentSummary` (AgentNodes) share for the "settled" concept, so the two faces
 *  can't disagree on done-ness — and adding a `NodeStatus` forces a decision
 *  here rather than silently defaulting to "terminal". */
export const NON_TERMINAL_STATUSES = new Set<NodeStatus>(["pending", "running"]);

/** The two encodings of `STATUS_META`'s hue. Which *medium* a face paints in is
 *  a real difference — a stream takes escape wrappers, opentui takes cell
 *  attributes — but which *hue* a status gets is not, and stating it twice is
 *  how the live matrix and `printVerdict` came to disagree about `cancelled`.
 *  Adding a `NodeStatus` is still one edit, in `STATUS_META`. */
const ANSI_BY_HUE: Record<StatusHue, (s: string) => string> = {
  grey: dim,
  amber: yellow,
  green,
  red,
  violet: magenta,
};

const CELL_BY_HUE: Record<StatusHue, string> = {
  grey: "#6b7a80",
  amber: "#e6b24d",
  green: "#6fcf8e",
  red: "#e8695b",
  violet: "#bb8ce2",
};

function byStatus<T>(pick: (hue: StatusHue) => T): Record<NodeStatus, T> {
  const out = {} as Record<NodeStatus, T>;
  for (const status of Object.keys(STATUS_META) as NodeStatus[]) {
    out[status] = pick(STATUS_META[status].hue);
  }
  return out;
}

/** Per-status colour, shared by every face (attach table, run matrix,
 *  verdict) — a no-op when stdout isn't a TTY, so pure-string tests and
 *  captured logs see the bare glyphs. */
const STATUS_COLOR: Record<NodeState["status"], (s: string) => string> =
  byStatus((hue) => ANSI_BY_HUE[hue]);

/** The same assignment as a terminal-cell attribute, for the live view's
 *  renderer (which owns cells, not escape sequences). */
export const STATUS_CELL: Record<NodeState["status"], string> = byStatus(
  (hue) => CELL_BY_HUE[hue],
);

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
  cancelled: number;
  /** No node is pending or running — the pipeline has settled. */
  done: boolean;
  /** Settled with at least one failure or infrastructure error. */
  failedOverall: boolean;
  /** Settled with no red and no operator-cancelled nodes — a clean pass.
   *  Cancel is not red but is also not a clean pass (juspay/odu#68). */
  clean: boolean;
}

/** The machine-readable snapshot of one node — the snake_cased projection
 *  shared by `odu status -o json` and the MCP agent `nodes` resource, so the
 *  two agent/tooling faces speak one vocabulary (both `id` and `name`) instead
 *  of re-deriving it inline and drifting. The agent rows (`rowsOf`) spread this
 *  and add the `red` verdict bit on top. */
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

/** One node, flattened for the agent face: the `nodeRow` projection plus the
 *  `red` verdict bit (gated on `STATUS_META`, the single source of redness so
 *  the agent verdict can't drift from the TUI/run verdict). The MCP `nodes`
 *  resource exposes these rows. */
export interface NodeRow extends NodeRowJson {
  red: boolean;
}

export function nodeRowRed(node: NodeState): NodeRow {
  return { ...nodeRow(node), red: STATUS_META[node.status].isRed };
}

/** Every node of a pipeline as agent rows, in scheduling order. */
export function rowsOf(state: PipelineState): NodeRow[] {
  return state.order
    .map((id) => state.nodes[id])
    .filter((n): n is NodeState => n !== undefined)
    .map(nodeRowRed);
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

/** The status buckets a counts line can show, in the order every face shows
 *  them. */
const COUNT_KEYS = [
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

/** The one-glyph rendering of an `Outcome`, for the live view's header and its
 *  recap. `pending` never reaches the frame (a spinner takes its place) but is
 *  what a recap of an unsettled run shows. */
export const OUTCOME_MARK: Record<Outcome, string> = {
  pending: "◼",
  ok: "✔",
  incomplete: "◼",
  failed: "✗",
};

/** The word `printVerdict` stamps on the summary line. */
export const OUTCOME_LABEL: Record<Outcome, string> = {
  pending: "RUNNING",
  ok: "OK",
  incomplete: "INCOMPLETE",
  failed: "FAILED",
};

/** The hue an outcome reads in — one assignment, both media, so the live
 *  header and `printVerdict` agree that an INCOMPLETE run is amber rather than
 *  neutral. */
const OUTCOME_HUE: Record<Outcome, StatusHue> = {
  pending: "grey",
  ok: "green",
  incomplete: "amber",
  failed: "red",
};

export const OUTCOME_COLOR: Record<Outcome, (s: string) => string> = {
  pending: ANSI_BY_HUE[OUTCOME_HUE.pending],
  ok: ANSI_BY_HUE[OUTCOME_HUE.ok],
  incomplete: ANSI_BY_HUE[OUTCOME_HUE.incomplete],
  failed: ANSI_BY_HUE[OUTCOME_HUE.failed],
};

export const OUTCOME_CELL: Record<Outcome, string> = {
  pending: CELL_BY_HUE[OUTCOME_HUE.pending],
  ok: CELL_BY_HUE[OUTCOME_HUE.ok],
  incomplete: CELL_BY_HUE[OUTCOME_HUE.incomplete],
  failed: CELL_BY_HUE[OUTCOME_HUE.failed],
};

/** The agent-face parallel of `summarize`, over the flattened `AgentNodes`
 *  rows: `done` when no row holds a non-terminal status (the same
 *  `NON_TERMINAL_STATUSES` taxonomy `summarize` uses, so the two faces can't
 *  disagree on settled-ness), and the red rows bucketed by status using each
 *  row's own `red` bit (the single source of redness, so the agent verdict
 *  can't drift from the TUI/run verdict). `wait_for_settle` consumes this
 *  instead of re-deriving done/red over the raw status strings. */
export function agentSummary(snap: AgentNodes): {
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

/** Short display name for a fan-in node id: `ci::e2e@x86_64-linux` → `e2e`
 *  (the matrix's columns carry the platform; `ci::` is the one module prefix
 *  every kolu pipeline shares, so it's noise in a narrow cell). */
export function recipeLabel(namepath: string): string {
  return namepath.startsWith("ci::") ? namepath.slice(4) : namepath;
}

/** Project the flat node-id `order` into the matrix axes the live view draws:
 *  the recipe rows and platform columns, each in first-seen order. The one home
 *  for the "flat list → 2D shape" rule, so the renderer and the hjkl navigator
 *  can never drift on how rows and columns are derived. */
export function matrixShape(order: readonly string[]): {
  recipes: string[];
  platforms: string[];
} {
  const recipes: string[] = [];
  const platforms: string[] = [];
  for (const id of order) {
    const { namepath, platform } = splitFanId(id);
    if (!recipes.includes(namepath)) recipes.push(namepath);
    if (!platforms.includes(platform)) platforms.push(platform);
  }
  return { recipes, platforms };
}

/** The node in one matrix cell, or undefined for a gap — a recipe that does
 *  not run on that platform. The one place the (recipe, platform) -> node rule
 *  lives, so the renderer that draws a cell, the navigator that steps between
 *  cells, and the mouse that clicks one cannot disagree about which node a cell
 *  holds. It was three hand-built id strings before. */
export function cellAt(
  state: PipelineState,
  recipe: string,
  platform: string,
): NodeState | undefined {
  return state.nodes[fanId(recipe, platform)];
}

/** Move the interactive focus one cell across the recipe × platform matrix:
 *  `h`/`l` step between platform columns on the current recipe row, `j`/`k`
 *  between recipe rows in the current platform column. Each axis wraps, and
 *  missing cells (a recipe that doesn't run on a platform — the `°` gaps) are
 *  skipped, so focus only ever lands on a real node. With no focus yet, lands on
 *  the first node; returns undefined when no other cell exists along that axis. */
export function stepFocus(
  order: readonly string[],
  focusedId: string | undefined,
  key: "h" | "j" | "k" | "l",
): string | undefined {
  if (focusedId === undefined) return order[0];
  const { recipes, platforms } = matrixShape(order);
  // Each existing cell keyed by `fanId(recipe, platform)` back to its original
  // id, so a step returns the real id rather than a re-synthesized one — a
  // lane-local id without `@` would otherwise rebuild into a different string
  // and never match.
  const cells = new Map(
    order.map((id) => {
      const { namepath, platform } = splitFanId(id);
      return [fanId(namepath, platform), id] as const;
    }),
  );
  const { namepath, platform } = splitFanId(focusedId);
  const horizontal = key === "h" || key === "l";
  const axis = horizontal ? platforms : recipes;
  const delta = key === "l" || key === "j" ? 1 : -1;
  const start = axis.indexOf(horizontal ? platform : namepath);
  if (start === -1) return undefined;
  for (let stepCount = 1; stepCount < axis.length; stepCount++) {
    const pos =
      (((start + delta * stepCount) % axis.length) + axis.length) % axis.length;
    // `pos` is always in range; the guard only satisfies noUncheckedIndexedAccess.
    const at = axis[pos];
    if (at === undefined) continue;
    const candidate = horizontal
      ? cells.get(fanId(namepath, at))
      : cells.get(fanId(at, platform));
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

/** An operator-facing line rendered for a plain stream rather than a frame.
 *  Both faces that have to emit one before the live frame exists — the display
 *  adapter while the view is still loading, and the view itself before the
 *  renderer mounts — go through here, so the two cannot drift on styling.
 *  Lives in render.ts because the adapter must not import the view eagerly. */
export function operatorLine(text: string): string {
  return dim(stripAnsi(text));
}

/** `3cbac86` for a clean run, `3cbac86+dirty` when the working tree has
 *  uncommitted changes — every face shows which code the verdict is about.
 *  Lives here, with the other cross-face projections, because the live view,
 *  the verdict line and `printVerdict` all need it and `cli/` cannot import
 *  from `coordinator/`. */
export function commitLabel(
  state: Pick<PipelineState, "sha7" | "dirty">,
): string {
  return state.dirty ? `${state.sha7}+dirty` : state.sha7;
}

/** How a run ended, in the two-or-three lines a host prints once its viewport
 *  is gone. Pure in the state, so the caller needs nothing from the view and
 *  there is no "call stop() first" ordering to get wrong: `attach` prints it
 *  from the last state it saw. `run` has its own `printVerdict` and ignores
 *  this. */
export function verdictLine(state: PipelineState): string {
  const s = summarize(state);
  const reds = state.order
    .map((id) => state.nodes[id])
    .filter(
      (n): n is NodeState => n !== undefined && STATUS_META[n.status].isRed,
    );
  const lines = [
    `${OUTCOME_MARK[outcomeOf(s)]} ${state.name} @ ${commitLabel(state)}  ${countsLine(s)}`,
  ];
  for (const n of reds.slice(0, 3)) {
    lines.push(`  ${STATUS_META[n.status].glyph} ${n.id}`);
  }
  // Say so when the list is clipped — a silent truncation reads as "those are
  // all the failures", which is the one thing a verdict must not imply.
  if (reds.length > 3) lines.push(`  … +${reds.length - 3} more`);
  return `${lines.join("\n")}\n`;
}
