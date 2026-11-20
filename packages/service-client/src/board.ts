import { STATUS_META, type StatusHue } from "@odu/run-client/surface";

export type { StatusHue };
import type {
  RunBoardState,
  RunNode,
  RunOutcome,
  RunRow,
} from "./surface";

/** What a run's own status cell says — the ONE fold both of this package's
 *  faces and every downstream board reads. */
export function runStatus(run: Pick<RunRow, "state" | "outcome">): {
  label: string;
  hue: StatusHue;
} {
  return run.outcome === null
    ? BOARD_STATE[run.state]
    : OUTCOME[run.outcome];
}

/** What each board state is called, and what colour it carries. The hue names
 *  are the same five {@link STATUS_META} uses. */
export const BOARD_STATE: Record<
  RunBoardState,
  { label: string; hue: StatusHue }
> = {
  provisioning: { label: "provisioning", hue: "amber" },
  running: { label: "running", hue: "amber" },
  settled: { label: "settled", hue: "grey" },
  owner_lost: { label: "owner lost", hue: "violet" },
  expired: { label: "expired", hue: "grey" },
};

/** A run's terminal word. */
export const OUTCOME: Record<RunOutcome, { label: string; hue: StatusHue }> = {
  passed: { label: "passed", hue: "green" },
  failed: { label: "failed", hue: "red" },
  incomplete: { label: "incomplete", hue: "amber" },
};

/** A run the machines are still working on. */
export const isActive = (row: RunRow): boolean =>
  row.state === "running" || row.state === "provisioning";

/** A run with a failure nobody has resolved. */
export const isFailing = (row: RunRow): boolean => row.unresolvedFailures > 0;

/**
 * HOW LONG THE RUN TOOK, or has taken so far — the ONE elapsed rule, read by
 * every face that prints a run's duration.
 *
 * STOPS AT THE VERDICT. A run still going has no `finishedAt`, and reads
 * against the caller's clock.
 */
export function runElapsedMs(
  run: Pick<RunRow, "createdAt" | "finishedAt">,
  now: number,
): number {
  return Math.max(0, (run.finishedAt ?? now) - run.createdAt);
}

/** A duration, at the precision a person reads it — the ONE rendering a BOARD
 *  spells a number of milliseconds with. */
export function duration(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.round(seconds - minutes * 60)).padStart(2, "0")}s`;
}

/** WHERE a lane sat in its run — the ONE geometry a timeline is drawn from, so
 *  odu's run detail and any downstream panel that grows one cannot place the
 *  same lane at two different x. */
export interface LaneSpan {
  /** `running` is still arriving; `settled` has its own duration. */
  kind: "settled" | "running";
  /** Fraction of the run elapsed before this attempt started. */
  left: number;
  /** Fraction of the run this attempt occupied. */
  width: number;
  /** `left` in milliseconds. */
  startedAfterMs: number;
  /** `width` in milliseconds, clamped the same way. */
  tookMs: number;
}

/** One lane's bar, or `null` where there is no span to know. */
export function laneSpan(
  lane: Pick<RunNode, "status" | "startedAt" | "durationMs">,
  run: Pick<RunRow, "createdAt" | "finishedAt">,
  now: number,
): LaneSpan | null {
  const startedAt = lane.startedAt;
  if (startedAt === null) return null;
  const stop = laneStop(lane, run, startedAt, now);
  if (stop === null) return null;
  const scale = runElapsedMs(run, now);
  const startedAfterMs = clampMs(startedAt - run.createdAt, scale);
  const tookMs = clampMs(stop.endedAt - startedAt, scale - startedAfterMs);
  return {
    kind: stop.kind,
    left: fractionOf(startedAfterMs, scale),
    width: fractionOf(tookMs, scale),
    startedAfterMs,
    tookMs,
  };
}

/**
 * THE PUSH, AS A SECOND SEGMENT ON THE SAME BAR — where a node's cache push
 * sat inside the run, or `null` where there is no push to draw.
 */
export function pushSpan(
  node: Pick<RunNode, "status" | "startedAt" | "durationMs" | "push">,
  run: Pick<RunRow, "createdAt" | "finishedAt">,
  now: number,
): LaneSpan | null {
  const push = node.push;
  if (push === undefined) return null;
  const recipe = laneSpan(node, run, now);
  if (recipe === null) return null;
  const scale = runElapsedMs(run, now);
  const startedAfterMs = clampMs(recipe.startedAfterMs + recipe.tookMs, scale);
  const room = scale - startedAfterMs;
  if (room <= 0) return null;
  const tookMs =
    push.state === "pushing" ? room : clampMs(push.durationMs, room);
  return {
    kind: push.state === "pushing" ? "running" : "settled",
    left: fractionOf(startedAfterMs, scale),
    width: fractionOf(tookMs, scale),
    startedAfterMs,
    tookMs,
  };
}

export { pushTotals } from "@odu/run-client/surface";

function laneStop(
  lane: Pick<RunNode, "status" | "durationMs">,
  run: Pick<RunRow, "finishedAt">,
  startedAt: number,
  now: number,
): { kind: LaneSpan["kind"]; endedAt: number } | null {
  if (lane.durationMs !== null) {
    return { kind: "settled", endedAt: startedAt + lane.durationMs };
  }
  if (lane.status !== "running") return null;
  return run.finishedAt === null
    ? { kind: "running", endedAt: now }
    : { kind: "settled", endedAt: run.finishedAt };
}

function clampMs(value: number, ceiling: number): number {
  return value > 0 ? Math.min(value, ceiling) : 0;
}

function fractionOf(ms: number, scale: number): number {
  return scale <= 0 ? 0 : ms / scale;
}

/** One mark on a timeline's axis. */
export interface TimelineTick {
  /** Where the mark sits, `0`–`1` across the track. */
  at: number;
  /** The elapsed time it stands for, for the caller to spell. */
  ms: number;
}

/** The axis the bars are read against: the run's start, two marks across it,
 *  and the run's own total. */
export function timelineTicks(
  run: Pick<RunRow, "createdAt" | "finishedAt">,
  now: number,
): TimelineTick[] {
  const scale = runElapsedMs(run, now);
  return [0, 1 / 3, 2 / 3, 1].map((at) => ({ at, ms: Math.round(scale * at) }));
}

type ScopeShape = Pick<
  RunRow["scope"],
  "selectors" | "platforms" | "root" | "noDeps"
>;

function scopeParts(scope: ScopeShape): string[] {
  return [
    scope.root === undefined ? "" : `under ${scope.root}`,
    scope.selectors.join(" "),
    scope.platforms.join(" "),
    scope.noDeps ? "no deps" : "",
  ].filter((part) => part !== "");
}

/**
 * The scope as a QUALIFIER — what a reader appends after the run it belongs to —
 * or `null` when the run covered the whole pipeline and a qualifier would say
 * nothing.
 */
export function scopeSuffix(scope: ScopeShape): string | null {
  const parts = scopeParts(scope);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** What a green here actually covers — the whole reason a scope rides the row. */
export function scopeLabel(scope: ScopeShape): string {
  const parts = scopeParts(scope).join(" · ");
  if (parts === "") return "whole pipeline";
  return scope.selectors.length === 0 && scope.root === undefined
    ? `whole pipeline · ${parts}`
    : parts;
}

/** Rows NEWEST `createdAt` first. `runId` breaks a `createdAt` tie, so the order
 *  is TOTAL. */
export function newestFirst(rows: Iterable<RunRow>): RunRow[] {
  return [...rows].sort(
    (a, b) => b.createdAt - a.createdAt || (a.runId > b.runId ? -1 : 1),
  );
}

/**
 * WHICH CHECKOUTS ARE ON THE BOARD, in the order their newest run puts them.
 */
export function checkoutRoots(rows: Iterable<RunRow>): string[] {
  const roots = new Set<string>();
  for (const row of rows) roots.add(row.repoRoot);
  return [...roots];
}

/** WHAT THE BOARD IS SAYING, at a glance — asked of the runs the checkouts
 *  STAND FOR (each checkout's newest, as `streams.checkout` reports it). */
export function boardTally(standingFor: Iterable<RunRow>): {
  failing: number;
  active: number;
} {
  let failing = 0;
  let active = 0;
  for (const row of standingFor) {
    if (isFailing(row)) failing += 1;
    if (isActive(row)) active += 1;
  }
  return { failing, active };
}
