/**
 * THE BOARD — every registered run, across every repository and worktree.
 *
 * This is the view the whole service exists for. A person with four checkouts
 * and two machines has, today, four terminals and no answer to "what is my CI
 * doing"; the catalog made that question answerable and this is where it gets
 * answered.
 *
 * Each row carries what a person needs to CHOOSE a run without opening it:
 * which project and worktree, which branch, the exact commit that was tested,
 * what the run covered, where it is, and whether anything is waiting on them.
 * The last of those is the one that earns its place — `unresolvedFailures` and
 * `reportingDebt` are the two ways a run can be quietly wrong, and a board that
 * made you click to find out has not told you anything.
 *
 * By DEFAULT the board is one row per checkout — the latest run of each — and
 * everything else is behind the History toggle. A person with four checkouts
 * asks "what is my CI doing", and forty rows of superseded history is the same
 * question left unanswered; see `latestPerCheckout` for why that collapse
 * happens before the filters rather than after them.
 *
 * Nothing here computes a verdict. Every field is the service's own row; the
 * view collapses, sorts, filters and words it.
 */

import { createMemo, createSignal, For, Index, Show, type JSX } from "solid-js";
import { Button, Pill } from "./dom";
import {
  ago,
  BOARD_STATE,
  OUTCOME,
  projectOf,
  runRef,
  scopeLabel,
} from "./format";
import type { RunRow } from "./types";

/** What a board can be narrowed to. Deliberately three coarse buckets rather
 *  than a query language: the question a person actually asks of a CI board is
 *  "what is running", "what is broken" and "everything", and anything finer is
 *  better served by opening the run. */
export type BoardFilter = "all" | "active" | "attention";

const FILTERS: { id: BoardFilter; label: string; hint: string }[] = [
  { id: "attention", label: "Needs attention", hint: "runs with an unresolved failure or unposted status" },
  { id: "active", label: "Active", hint: "provisioning or running" },
  { id: "all", label: "All", hint: "every run in the catalog" },
];

function matches(row: RunRow, filter: BoardFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "active":
      return row.state === "running" || row.state === "provisioning";
    case "attention":
      return row.unresolvedFailures > 0 || row.reportingDebt > 0;
  }
}

/**
 * ONE ROW PER CHECKOUT — the newest run of each, in the order they came in.
 *
 * Exported because the tab title reads it too (`app.tsx`), and a tab that
 * counted every run while the board under it counted checkouts would be two
 * different answers to one question.
 *
 * The order of the input is preserved rather than re-derived, so the caller's
 * sort — newest first — survives the collapse.
 */
export function latestPerCheckout(rows: RunRow[]): RunRow[] {
  const newest = new Map<string, RunRow>();
  for (const row of rows) {
    const held = newest.get(row.repoRoot);
    if (held === undefined || row.createdAt > held.createdAt) {
      newest.set(row.repoRoot, row);
    }
  }
  return rows.filter((row) => newest.get(row.repoRoot) === row);
}

/** How many runs each checkout has, so a collapsed row can say how many it
 *  stands for. Keyed by `repoRoot` and not by project: two worktrees of one
 *  repo share a last path segment and are two different checkouts. */
function runsPerCheckout(rows: RunRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.repoRoot, (counts.get(row.repoRoot) ?? 0) + 1);
  return counts;
}

/** Does this row answer the search box? Case-insensitive substring, over the
 *  three strings a person would type: the project, the branch, and the whole
 *  checkout path — the last because that is the only thing telling two
 *  worktrees of one repo apart. An empty box matches everything. */
function searched(row: RunRow, needle: string): boolean {
  if (needle === "") return true;
  return (
    projectOf(row.repoRoot).toLowerCase().includes(needle) ||
    (row.branch ?? "").toLowerCase().includes(needle) ||
    row.repoRoot.toLowerCase().includes(needle)
  );
}

/** One row. A `<button>` rather than a clickable `<div>`: it is reachable by
 *  Tab, fires on Enter and Space, and is announced as a control — see
 *  `./dom`'s `Button`, which is where that decision is made once. This one is
 *  spelled out rather than built from `Button` because a row is a grid of
 *  labelled cells, not a control with a caption. */
function Row(props: {
  run: RunRow;
  now: number;
  /** How many OLDER runs of this checkout the board folded away behind this
   *  row. Zero when there are none, and zero throughout when History is on —
   *  nothing is folded away then, so there is nothing to count. */
  earlier: number;
  onOpen: (runId: string) => void;
}): JSX.Element {
  const state = (): (typeof BOARD_STATE)[RunRow["state"]] =>
    BOARD_STATE[props.run.state];
  return (
    <button
      type="button"
      class="row"
      classList={{
        [`row-${props.run.state}`]: true,
        "row-red": props.run.unresolvedFailures > 0,
      }}
      onClick={() => props.onOpen(props.run.runId)}
      // The whole path, because two worktrees of one repo share a last segment
      // and the difference is exactly what a multi-worktree board is for.
      title={props.run.repoRoot}
    >
      <span class="row-project">
        {projectOf(props.run.repoRoot)}
        <Show when={props.run.branch}>
          {(branch) => <span class="row-branch">{branch()}</span>}
        </Show>
      </span>
      <span class="row-sha">
        {runRef(props.run.sha, props.run.seq)}
        <Show when={props.run.dirty}>
          <span class="row-dirty">+dirty</span>
        </Show>
      </span>
      {/* ONE status cell, not two. A run's board state and its outcome used to
          have a column each, and each was empty in exactly the rows where the
          other one was full: "settled" beside "failed" says nothing "failed"
          did not already say, and a live run has no outcome to put anywhere.
          So the cell holds whichever of the two IS the answer — the verdict
          once there is one, and where the run has got to until then. */}
      <span class="row-status">
        <Show
          when={props.run.outcome}
          fallback={<Pill hue={state().hue}>{state().label}</Pill>}
        >
          {(outcome) => (
            <Pill hue={OUTCOME[outcome()].hue}>{OUTCOME[outcome()].label}</Pill>
          )}
        </Show>
      </span>
      <span class="row-attention">
        <Show when={props.run.unresolvedFailures > 0}>
          <Pill hue="red">{`${props.run.unresolvedFailures} failing`}</Pill>
        </Show>
        <Show when={props.run.reportingDebt > 0}>
          <Pill hue="amber">{`${props.run.reportingDebt} unposted`}</Pill>
        </Show>
      </span>
      <span class="row-scope">{scopeLabel(props.run.scope)}</span>
      {/* The age, and under it what the collapse hid. It rides the age cell
          because that is what it is about — the OLDER runs of this checkout —
          and it says the number rather than merely hinting there are some, so
          a person can tell one superseded run from forty before pressing
          History. */}
      <span class="row-age">
        {ago(props.run.createdAt, props.now)}
        <Show when={props.earlier > 0}>
          <span class="row-earlier">{`${props.earlier} earlier`}</span>
        </Show>
      </span>
    </button>
  );
}

/**
 * The board.
 *
 * `rows` and `now` are plain values, and they stay live because the compiler
 * turns a dynamic JSX prop into a getter on this component's `props` — see
 * `./dom`'s header. So the ages tick without the rows moving, and a catalog
 * update repaints the cells it changed rather than the list.
 */
export function Board(props: {
  rows: RunRow[];
  now: number;
  loading: boolean;
  onOpen: (runId: string) => void;
  onCreate: () => void;
}): JSX.Element {
  const [filter, setFilter] = createSignal<BoardFilter>("all");
  const [history, setHistory] = createSignal(false);
  const [query, setQuery] = createSignal("");
  /** How many runs each checkout has in the catalog, counted over EVERY row —
   *  the collapsed rows are the ones being counted, so this cannot be taken
   *  off the shown list. */
  const counts = createMemo(() => runsPerCheckout(props.rows));
  const shown = createMemo(() => {
    // THE COLLAPSE COMES FIRST, before the bucket filter and before the search,
    // and the order is the whole meaning of "needs attention". That bucket is
    // about what is CURRENTLY wrong with a checkout, and a superseded run's red
    // is history: filter first and a checkout you fixed an hour ago sits in the
    // attention bucket forever, because the run that failed is still in the
    // catalog. Collapse first and the bucket asks the question a person meant.
    const base = history() ? props.rows : latestPerCheckout(props.rows);
    const needle = query().trim().toLowerCase();
    return base.filter((run) => matches(run, filter()) && searched(run, needle));
  });
  return (
    <section class="board">
      <header class="board-head">
        <h1>Runs</h1>
        {/* The search box. A `type="search"` input rather than a text one, so
            the browser draws its own clear affordance and announces it as what
            it is. The three `off`s are about a PATH and a BRANCH: autocorrect
            on a mobile keyboard turns `web-ui-redesign` into prose, and a
            capitalised first letter never matches a lowercase project. */}
        <input
          type="search"
          class="input board-search"
          aria-label="Filter by project or branch"
          placeholder="project or branch"
          spellcheck={false}
          autocapitalize="off"
          autocorrect="off"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        {/* Which filter is ACTIVE is state, and state a sighted person reads
            off a highlight has to be in the DOM for everybody else — so it
            rides the element as `aria-pressed` rather than as a class name. */}
        <div class="filters" role="group" aria-label="Filter runs">
          <For each={FILTERS}>
            {(entry) => (
              <Button
                title={entry.hint}
                pressed={filter() === entry.id}
                onClick={() => setFilter(entry.id)}
              >
                {entry.label}
              </Button>
            )}
          </For>
        </div>
        {/* OUTSIDE the filter group, deliberately. The three chips narrow the
            board to a bucket and are one control between them; this one changes
            what a row IS — a checkout, or a run — and putting it in the group
            would announce four mutually exclusive filters where there are
            three. It is a toggle, so it carries `aria-pressed` like they do. */}
        <Button
          class="btn history"
          title="show every run of every checkout, not just the latest"
          pressed={history()}
          onClick={() => setHistory((on) => !on)}
        >
          History
        </Button>
        <Button class="btn btn-primary" onClick={props.onCreate}>
          New run
        </Button>
      </header>
      {/* Three states, told apart. "Nothing yet" and "nothing MATCHING" are
          different answers, and a board that showed one blank panel for both
          would send somebody looking for a run that is right there under
          another filter. */}
      <div class="board-body">
        <Show when={props.loading}>
          <p class="empty">Reading the catalog…</p>
        </Show>
        <Show when={!props.loading && props.rows.length === 0}>
          <p class="empty">
            No runs in the catalog yet. Start one with <code>odu run</code> in a
            checkout, or with the button above.
          </p>
        </Show>
        <Show
          when={!props.loading && props.rows.length > 0 && shown().length === 0}
        >
          <p class="empty">
            No runs match this filter — every run in the catalog is quiet.
          </p>
        </Show>
        {/* The column heads — a VISUAL guide, and nothing else.
            `aria-hidden` because the rows below are buttons rather than table
            cells, so nothing binds a head to the value under it; six stray
            nouns announced ahead of the list would be noise to a screen reader,
            which reads each row as one control with its facts in order. They
            appear only when there are rows to label, and the stylesheet drops
            them on a narrow viewport where the row reflows and the labels would
            be sitting over the wrong cells. */}
        <Show when={shown().length > 0}>
          <div class="row-head" aria-hidden="true">
            <span>Project</span>
            <span>Commit</span>
            <span>Status</span>
            <span>Attention</span>
            <span>Scope</span>
            <span>Age</span>
          </div>
        </Show>
        {/* `Index`, not `For`. The catalog is a live collection that re-sends a
            row object whenever anything on it moves, so keying by REFERENCE —
            what `For` does — would tear down and rebuild a row on every tick,
            taking the keyboard focus and any in-progress interaction with it.
            Keying by position instead leaves the row's DOM alone and updates
            only the cells whose value actually changed, which is the whole
            reason this app is written in Solid. */}
        <Index each={shown()}>
          {(run) => (
            <Row
              run={run()}
              now={props.now}
              // Nothing is folded away while History is pressed, so there is
              // nothing for a row to stand for.
              earlier={
                history() ? 0 : (counts().get(run().repoRoot) ?? 1) - 1
              }
              onOpen={props.onOpen}
            />
          )}
        </Index>
      </div>
    </section>
  );
}
