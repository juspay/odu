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
 *  having changed reads as activity. */
export function newestFirst(rows: Iterable<RunRow>): RunRow[] {
  return [...rows].sort(
    (a, b) => b.createdAt - a.createdAt || (a.runId < b.runId ? -1 : 1),
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
