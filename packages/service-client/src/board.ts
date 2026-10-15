/**
 * `@odu/service-client/board` — the READINGS a board performs on the service's
 * own rows: which are moving, which are failing, and what a run is called.
 *
 * It lives here rather than in a face because a board is not one face's idea.
 * `packages/web-ui` is the board today and a terminal dashboard, an agent's
 * summary or a downstream repo's panel is the same board tomorrow — and the
 * alternative is what this module was extracted from: `web-ui`'s own
 * `byCheckout` / `isActive` / `isFailing` / `BOARD_STATE` / `OUTCOME`, plus a
 * second copy of the verdict fold wherever else a row needed a word. Two copies
 * of "what is this run called" is how one face comes to paint a torn-down run
 * `failed` while the other says `incomplete` — the exact sentence
 * {@link RunOutcomeSchema} spends a paragraph on.
 *
 * The COLLAPSE is no longer here. "Which run stands for a checkout, and how
 * many are behind it" was the one reading that had to be re-run on every row
 * delta and then joined to a second subscription for that run's work — so it
 * moved to the service, as `streams.checkout`, and every face reads it off the
 * wire. What is left is addressing ({@link checkoutRoots}) and the words a row
 * already carries.
 *
 * NOTHING HERE COMPUTES A VERDICT. Every field is the service's own row; these
 * functions sort and pick the word a row already carries. A fold that
 * re-derived "is this run red" from anything but `unresolvedFailures` would be a
 * second authority on the question the catalog exists to answer.
 *
 * BROWSER-SAFE, like the rest of this package: `effect` and this package's own
 * schemas, no `node:` anything (the closure test enforces it).
 */

import { STATUS_META, type StatusHue } from "@odu/run-client/surface";

/** The five semantic hues a reading carries, re-exported so a face that maps
 *  them onto its own palette imports one module. */
export type { StatusHue };
import type {
  RunBoardState,
  RunNode,
  RunOutcome,
  RunRow,
} from "./surface";

// ── one run, as a board names it ────────────────────────────────────────────

/** What a run's own status cell says — the ONE fold both of this package's
 *  faces and every downstream board reads.
 *
 *  A run's board STATE and its OUTCOME used to have a column each, and each was
 *  empty in exactly the rows where the other was full: "settled" beside
 *  "failed" says nothing "failed" did not already say, and a live run has no
 *  outcome to put anywhere. So the cell holds whichever of the two IS the
 *  answer — the verdict once there is one, and where the run has got to until
 *  then.
 *
 *  The precedence is load-bearing, not cosmetic: a run that was cancelled or
 *  whose coordinator was interrupted settles with `passed: false` and
 *  `outcome: "incomplete"`, and a reader that skipped the outcome would call it
 *  `failed` and send an operator looking for a test that broke. */
export function runStatus(run: Pick<RunRow, "state" | "outcome">): {
  label: string;
  hue: StatusHue;
} {
  return run.outcome === null
    ? BOARD_STATE[run.state]
    : OUTCOME[run.outcome];
}

/** What each board state is called, and what colour it carries. The hue names
 *  are the same five {@link STATUS_META} uses — one assignment of meaning to
 *  colour across every odu face. */
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

/** A run's terminal word. `null` — no outcome yet — is deliberately absent from
 *  this table: a run that has not finished has nothing to say here, and a
 *  fallback label would be a verdict about a run that has not reached one. */
export const OUTCOME: Record<RunOutcome, { label: string; hue: StatusHue }> = {
  passed: { label: "passed", hue: "green" },
  failed: { label: "failed", hue: "red" },
  incomplete: { label: "incomplete", hue: "amber" },
};

/** A run the machines are still working on. */
export const isActive = (row: RunRow): boolean =>
  row.state === "running" || row.state === "provisioning";

/** A run with a failure nobody has resolved — the board's red rail, its failing
 *  pill, and a tab's own count, from one rule. Named once because a second
 *  spelling of it in another module is how a tab starts disagreeing with the
 *  board under it. */
export const isFailing = (row: RunRow): boolean => row.unresolvedFailures > 0;

/**
 * HOW LONG THE RUN TOOK, or has taken so far — the ONE elapsed rule, read by
 * every face that prints a run's duration.
 *
 * STOPS AT THE VERDICT. An elapsed time that kept counting after a run finished
 * would make every settled row's age a function of when somebody looked at it,
 * which is the one thing a durable record is supposed to be free of. A run
 * still going has no `finishedAt`, and reads against the caller's clock — which
 * is what makes the live row tick and the settled ones stand still.
 *
 * `Math.max` guards the single way this can go backwards: a verdict stamped on
 * a lane host whose clock is behind the one that registered the run. A negative
 * duration is not a fact about anything, and zero is the honest floor.
 *
 * It lives here, beside the other readings, rather than in the service that
 * used to own it: the service had the only copy and the only consumer
 * (`RunEnv.elapsedMs`), so a board that wanted a settled run's duration could
 * not have one. A second subtraction in a face would be a second answer to how
 * long a run took.
 */
export function runElapsedMs(
  run: Pick<RunRow, "createdAt" | "finishedAt">,
  now: number,
): number {
  return Math.max(0, (run.finishedAt ?? now) - run.createdAt);
}

/** A duration, at the precision a person reads it — the ONE rendering a BOARD
 *  spells a number of milliseconds with. Three cells share it: a run's `Took`
 *  on the browser board, a node's own duration in its detail view
 *  (`web-ui/format` re-exports this one rather than keeping a copy), and the
 *  duration column of `odu history list`. It sits beside {@link runElapsedMs}
 *  because the rule and its spelling are the same answer asked twice; it was
 *  `web-ui`'s own, which left the CLI with no way to print a duration but to
 *  invent a second one.
 *
 *  `formatGoDuration` (`@odu/execution/common/duration`) is NOT a rival: it is
 *  byte-compatible with the Go `time.Duration` strings justci posted to commit
 *  statuses, so branch-protection tooling and humans already parse it. The
 *  terminal live view prints that one for the same reason the status does — a
 *  wire format, not a reader's preference. A board cell has no such consumer
 *  and takes the readable spelling. */
export function duration(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.round(seconds - minutes * 60)).padStart(2, "0")}s`;
}

/** WHERE a lane sat in its run, as fractions of the run's own timeline — the
 *  ONE geometry both timeline faces draw from, so odu's run detail and a
 *  downstream panel cannot place the same lane at two different x.
 *
 *  A GANTT, not a length: `left` is where the lane STARTED relative to the
 *  run's own start, which is the whole reason the picture is worth drawing.
 *  Lengths alone say how long each lane took and nothing about what ran beside
 *  what, and "what was the critical path" is the question a reader opens a run
 *  to answer. */
export interface LaneSpan {
  /** Fraction of the run elapsed before this lane started. */
  left: number;
  /** Fraction of the run this lane occupied. */
  width: number;
}

/**
 * One lane's bar, or `null` for a lane that has not started.
 *
 * The scale is {@link runElapsedMs} — the run's OWN elapsed — so a live run's
 * track is always exactly full and the bars shrink into it as the run grows,
 * rather than a track that ends wherever the last lane happens to reach.
 *
 * `null` rather than a zero-width bar, because "has not started" and "started
 * and took no time" are different facts and an empty track is itself the
 * signal. A caller renders nothing; it must not invent a sliver.
 *
 * EVERYTHING IS CLAMPED into the track. A lane host whose clock runs behind
 * the registrar's reports a start before the run began — skew, not a negative
 * offset, the same floor `runElapsedMs` applies — and one running ahead would
 * otherwise push a bar past the right edge. A run with no elapsed time yet
 * (the first millisecond, a replayed record) has nothing to divide by, and
 * answers `{left: 0, width: 0}` rather than `NaN`.
 */
export function laneSpan(
  lane: Pick<RunNode, "startedAt" | "durationMs">,
  run: Pick<RunRow, "createdAt" | "finishedAt">,
  now: number,
): LaneSpan | null {
  const startedAt = lane.startedAt;
  if (startedAt === null) return null;
  const scale = runElapsedMs(run, now);
  if (scale <= 0) return { left: 0, width: 0 };
  // A lane still going is measured against the caller's clock, which is what
  // makes its bar grow — the same arm `runElapsedMs` takes for a live run.
  const took = lane.durationMs ?? now - startedAt;
  const left = clampFraction((startedAt - run.createdAt) / scale);
  return { left, width: Math.min(clampFraction(took / scale), 1 - left) };
}

/** Into `[0, 1]`, and never `NaN`. */
function clampFraction(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** The axis under a lane timeline: the run's start, two marks across it, and
 *  the run's own total. Each is a POSITION — a fraction of the track, the same
 *  coordinate {@link laneSpan} answers in, so a tick and a bar are placed by
 *  one rule — and the elapsed time that position stands for.
 *
 *  NO LABEL. Where a mark sits is geometry and is shared; how a face SPELLS a
 *  duration is that face's own vocabulary, and baking one spelling here put an
 *  axis reading `55.4s` over cells reading `55s` in the first consumer that
 *  drew both. So the claim this export makes is about the MARKS — two faces
 *  cannot tick one picture differently — and each face spells `ms` the way the
 *  rest of its rows already do (`duration` here, `compactPhrase` in kolu).
 *
 *  FOUR ticks at fixed positions rather than at a "nice" rounded interval: the
 *  track IS one run, so the marks that matter are its own thirds — and a
 *  rounded interval would leave a final tick somewhere short of the track's
 *  end, which is the one place a reader checks the total. */
export interface TimelineTick {
  /** Where the mark sits, `0`–`1` across the track. */
  at: number;
  /** The elapsed time it stands for, for the caller to spell. */
  ms: number;
}

export function timelineTicks(scale: number): TimelineTick[] {
  return [0, 1 / 3, 2 / 3, 1].map((at) => ({
    at,
    ms: Math.max(0, scale) * at,
  }));
}

/** The fields of a scope these readings use — narrowed off the row's own scope
 *  rather than restated, so a field added to the wire is one type error away
 *  from a reading that would ignore it, and a caller holding a full `RunScope`
 *  passes it unchanged.
 *
 *  `root` is here for the same reason the three flags are: a run rooted at a
 *  NAMEPATH expanded the DAG under it, so its lanes say nothing about the rest
 *  of the pipeline either — the misreading this whole reading exists to
 *  prevent. */
type ScopeShape = Pick<
  RunRow["scope"],
  "selectors" | "platforms" | "root" | "noDeps"
>;

/**
 * A scope's parts, in the order a reader meets them — the ONE place the
 * vocabulary is spelled, so the two renderings below cannot disagree about what
 * a `--root` or a `--no-deps` is called.
 *
 * An empty selector is emphatically NOT a part here: "the whole pipeline" is a
 * sentence a board cell owes the reader, and a qualifier must not say it — see
 * {@link scopeLabel} for why the two differ. */
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
 *
 * `null` rather than an empty string, because "say nothing" is a decision the
 * caller renders as NO suffix: a caller that forgot to test it would render a
 * stray separator. The one caller that must say something anyway is a board row,
 * where an empty cell would read as a run that tested nothing — see
 * {@link scopeLabel}.
 *
 * A selection is not a pipeline. `selectors: ["ci::unit"]` runs one recipe and
 * its dependencies, so the handful of lanes behind it says nothing about the
 * rest of the DAG — and a reader who takes those lanes for the whole pipeline
 * has been told the wrong thing about what is green.
 */
export function scopeSuffix(scope: ScopeShape): string | null {
  const parts = scopeParts(scope);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** What a green here actually covers — the whole reason a scope rides the row.
 *
 *  The difference from {@link scopeSuffix} is the cell, not the scope: a board
 *  row has nothing else to say about what the run covered, so an empty selector
 *  reads as the WHOLE pipeline rather than as an empty cell a reader takes for a
 *  run that tested nothing. A caller appending the scope to a run it has already
 *  named has that fact behind it and wants the qualifier or silence. */
export function scopeLabel(scope: ScopeShape): string {
  const parts = scopeParts(scope).join(" · ");
  if (parts === "") return "whole pipeline";
  // An explicit selection names what ran on its own, and so does a `--root`:
  // both narrow what RAN, so neither leaves a cell that can call itself the
  // whole pipeline. A platform slice and `--no-deps` qualify a whole-pipeline
  // run instead, which is why those keep the lead-in.
  return scope.selectors.length === 0 && scope.root === undefined
    ? `whole pipeline · ${parts}`
    : parts;
}

// ── the board, narrowed ─────────────────────────────────────────────────────

/** Rows NEWEST `createdAt` first. `runId` breaks a `createdAt` tie, so the order
 *  is TOTAL: two runs registered in the same millisecond must not swap places
 *  between two reads of one board, or a list that reshuffles without anything
 *  having changed reads as activity.
 *
 *  The tiebreak runs the SAME WAY the catalog's own id order does — later id
 *  first — because a run id leads with its start instant. Two ids that tie on
 *  `createdAt` are then still ordered the way everything else in odu orders
 *  them, instead of the one list in the system that reads a catalog backwards. */
export function newestFirst(rows: Iterable<RunRow>): RunRow[] {
  return [...rows].sort(
    (a, b) => b.createdAt - a.createdAt || (a.runId > b.runId ? -1 : 1),
  );
}

/**
 * WHICH CHECKOUTS ARE ON THE BOARD, in the order their newest run puts them.
 *
 * ADDRESSING, not a reading: it answers "which checkouts do I subscribe to",
 * and deliberately says nothing about which run stands for one or how many are
 * behind it. Those are `streams.checkout`'s answer now, folded once by the
 * service on the catalog's own clock — a face that re-derived them from rows it
 * happens to hold would be a second answer to the question that stream exists
 * to give, and would have to re-fold on every row delta.
 *
 * Keyed by `repoRoot` and not by project: two worktrees of one repo share a
 * last path segment and are two different checkouts. `rows` is expected newest
 * first ({@link newestFirst}), and a `Set` keeps insertion order — so the
 * checkout whose newest run is newest comes first.
 */
export function checkoutRoots(rows: Iterable<RunRow>): string[] {
  const roots = new Set<string>();
  for (const row of rows) roots.add(row.repoRoot);
  return [...roots];
}

/** WHAT THE BOARD IS SAYING, at a glance — asked of the runs the checkouts
 *  STAND FOR (each checkout's newest, as `streams.checkout` reports it), so the
 *  summary counts what the board shows and cannot drift from the page under it.
 *  `failing` is deliberately narrower than a "needs attention" bucket: an
 *  unposted status is a debt, not a failure, and a summary that cried "failing"
 *  over one would be one people turn off. */
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
