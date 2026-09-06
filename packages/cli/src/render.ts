/**
 * How a run's state LOOKS — glyphs, hues, cell attributes, the matrix layout,
 * and the one-line verdict. Pure functions of surface state: no I/O and no
 * terminal control, but every one of them commits to a MEDIUM.
 *
 * What a run's state MEANS moved out to `packages/execution/src/common/verdict.ts` — settled,
 * clean, the outcome, the counts, the row projections. The engine asks that
 * module its questions now, so nothing under `src/coordinator` imports this
 * one, and a face other than a terminal can be built over the engine without
 * dragging a glyph table along. This file re-exports nothing: a consumer that
 * wants a classification names the module that owns it.
 */

import {
  claimingLanes,
  leasedLanes,
  type NodeState,
  type NodeStatus,
  type PipelineState,
  type RunHeader,
  STATUS_META,
  type StatusHue,
} from "@odu/run-client/surface";
import { fanId, splitFanId } from "@odu/run-client/nodeId";
import {
  countsLine,
  outcomeOf,
  type Outcome,
  summarize,
} from "@odu/execution/common/verdict";
import { dim, green, magenta, red, stripAnsi, yellow } from "./ansi";

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

/** `x86_64-linux=kolu-ci-5 · aarch64-darwin=rasam`, or `""` when no lane has a
 *  host yet. Here with the other cross-face projections because three faces
 *  render it — `run`'s plain banner, its lane-resolved line, and `odu status`
 *  — and this file is where "the projection every face shares" lives. */
export function laneText(header: Pick<RunHeader, "lanes">): string {
  return leasedLanes(header)
    .map((l) => `${l.platform}=${l.host}`)
    .join(" · ");
}

/** `x86_64-linux from kolu-ci-5, kolu-ci-6` — what a run with no lanes yet is
 *  doing, so a captured log says which pool it is waiting on rather than going
 *  silent until the first transition (juspay/odu#84).
 *
 *  A second sentence over the same roster, not a second list: leased and
 *  claiming lanes read as different English ("x=host" vs "x from pool"), and
 *  `odu status` prints them on separate lines. */
export function claimingText(header: Pick<RunHeader, "lanes">): string {
  return claimingLanes(header)
    .map((c) => `${c.platform} from ${c.pool.join(", ")}`)
    .join(" · ");
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
