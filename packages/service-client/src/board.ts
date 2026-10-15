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

/** WHERE a lane sat in its run — the ONE geometry a timeline is drawn from, so
 *  odu's run detail and any downstream panel that grows one cannot place the
 *  same lane at two different x.
 *
 *  A GANTT, not a length: `left` is where the attempt STARTED relative to the
 *  run's own start, which is the whole reason the picture is worth drawing.
 *  Lengths alone say how long each lane took and nothing about what ran beside
 *  what, and "what was the critical path" is the question a reader opens a run
 *  to answer.
 *
 *  `kind` is the fold's OWN answer to "is this still arriving", carried so a
 *  face paints the hatch from the arm the geometry actually took. It used to be
 *  re-derived at each face — odu from `status`, a downstream panel from
 *  `durationMs` — which is three predicates for one fact and two of them wrong
 *  for a node that stopped without ever running.
 *
 *  The ms facts ride along for the same reason: a tooltip that re-subtracted
 *  `startedAt - createdAt` would be the one number on the row that skipped the
 *  clamping, and would print a negative offset for the skewed lane whose bar
 *  sits at the origin. */
export interface LaneSpan {
  /** `running` is still arriving; `settled` has its own duration. */
  kind: "settled" | "running";
  /** Fraction of the run elapsed before this attempt started. */
  left: number;
  /** Fraction of the run this attempt occupied. */
  width: number;
  /** `left` in milliseconds — clamped identically, so a caller spelling it
   *  cannot disagree with where the bar is drawn. */
  startedAfterMs: number;
  /** `width` in milliseconds, clamped the same way. */
  tookMs: number;
}

/**
 * One lane's bar, or `null` where there is no span to know.
 *
 * TWO ways to have no bar, and both are facts rather than gaps. A lane that
 * never started has no place on the timeline. And a lane that reached a
 * TERMINAL status without a duration never ran at all — `skipped` because a
 * dependency failed, or a lane torn down in provisioning (see
 * `@odu/execution`'s history: a node can reach a terminal status without ever
 * having run). Inferring "still arriving" from that absent duration is what
 * painted a skipped node as a nine-minute bar — the longest on the page, the
 * apparent critical path — beside its own empty duration cell.
 *
 * So the arm is a DISCRIMINANT on the status the node actually carries, never
 * on a null. A running node ends at `run.finishedAt ?? now`, which is what
 * freezes the picture of a settled run whose journal left a lane open: the
 * scale stops at the verdict (`runElapsedMs`), and a bar measured against
 * `now` inside a frozen track would widen for ever.
 *
 * The scale is {@link runElapsedMs} — the run's OWN elapsed — so a live run's
 * track is always exactly full and the bars shrink into it as the run grows,
 * rather than a track that ends wherever the last lane happens to reach.
 *
 * EVERYTHING IS CLAMPED ONCE, in milliseconds, before anything is divided. A
 * lane host whose clock runs behind the registrar's reports a start before the
 * run began — skew, not a negative offset, the same floor `runElapsedMs`
 * applies — and one running ahead lands at the track's END rather than being
 * swept back to the origin. The division is then the only place a zero-length
 * run is answered, and it answers `0` rather than `NaN`.
 */
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

/** HOW A LANE STOPS — which arm its bar is, and where that bar ends. One
 *  decision, so it is taken once: a lane with its own duration ends at its own
 *  duration, one still going ends at the clock, and a lane left open on a run
 *  that has FINISHED ends at the verdict and is settled whatever its journal
 *  says — a torn journal, a legacy import. Its bar is frozen there either way;
 *  hatching it as well would tell a reader that work is still arriving on a run
 *  that is over.
 *
 *  `null` is a lane whose span is not knowable: a terminal status with no
 *  duration never ran, and has no length to draw.
 *
 *  `startedAt` arrives as a number because the caller has already answered
 *  "did this lane start at all" — asking again here would be a second answer
 *  to it, and a stand-in for the `null` would be a lie about when. */
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

/** Into `[0, ceiling]` — the ONE clamp, and it works in MILLISECONDS, before
 *  anything is divided. That is what retires the non-finite guard the fraction
 *  form needed: an overflowing offset lands on the ceiling here, where a bar
 *  that outran its track belongs, instead of dividing to `Infinity` and being
 *  swept back to the origin — a bar at `left: 0` claims the work began with
 *  the run, which is the opposite of what happened.
 *
 *  TOTAL over every number, which is why the test is `> 0` rather than a
 *  `Math.max`: subtracting two infinities is `NaN`, and `Math.max(0, NaN)` is
 *  `NaN` — one unreadable instant on the wire would otherwise reach a style
 *  attribute as `width: NaN%`. */
function clampMs(value: number, ceiling: number): number {
  return value > 0 ? Math.min(value, ceiling) : 0;
}

/** A clamped millisecond count as a fraction of the track. The one place a run
 *  with no elapsed time is answered: there is nothing to divide by, and `0` is
 *  the honest picture of a run that has not taken any time yet. */
function fractionOf(ms: number, scale: number): number {
  return scale <= 0 ? 0 : ms / scale;
}

/** One mark on a timeline's axis. */
export interface TimelineTick {
  /** Where the mark sits, `0`–`1` across the track — the same coordinate
   *  {@link laneSpan} answers in, so a tick and a bar are placed by one rule. */
  at: number;
  /** The elapsed time it stands for, for the caller to spell. */
  ms: number;
}

/** The axis the bars are read against: the run's start, two marks across it,
 *  and the run's own total.
 *
 *  It takes the RUN and the clock, the same pair {@link laneSpan} takes, rather
 *  than a pre-derived scale: "the axis the bars are read against" was otherwise
 *  a convention every face had to keep by spelling `runElapsedMs(run, now)`
 *  into the call, and a face that passed anything else got an axis that agreed
 *  with no bar on the page. There is nothing left to guard against, which is
 *  why the guard is gone.
 *
 *  NO LABEL. Where a mark sits is geometry and is shared; how a face SPELLS a
 *  duration is that face's own vocabulary, and the number is minted in whole
 *  milliseconds so a three-second run's axis is not `833.3333333333334ms`.
 *
 *  FOUR ticks at fixed positions rather than at a "nice" rounded interval: the
 *  track IS one run, so the marks that matter are its own thirds — and a
 *  rounded interval would leave a final tick somewhere short of the track's
 *  end, which is the one place a reader checks the total. */
export function timelineTicks(
  run: Pick<RunRow, "createdAt" | "finishedAt">,
  now: number,
): TimelineTick[] {
  const scale = runElapsedMs(run, now);
  return [0, 1 / 3, 2 / 3, 1].map((at) => ({ at, ms: Math.round(scale * at) }));
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
