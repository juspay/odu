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
 * Nothing here computes a verdict. Every field is the service's own row; the
 * view sorts, filters and words it.
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

/** One row. A `<button>` rather than a clickable `<div>`: it is reachable by
 *  Tab, fires on Enter and Space, and is announced as a control — see
 *  `./dom`'s `Button`, which is where that decision is made once. This one is
 *  spelled out rather than built from `Button` because a row is a grid of
 *  labelled cells, not a control with a caption. */
function Row(props: {
  run: RunRow;
  now: number;
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
      <span class="row-state">
        <Pill hue={state().hue}>{state().label}</Pill>
      </span>
      <span class="row-outcome">
        <Show when={props.run.outcome}>
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
      <span class="row-age">{ago(props.run.createdAt, props.now)}</span>
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
  const shown = createMemo(() =>
    props.rows.filter((run) => matches(run, filter())),
  );
  return (
    <section class="board">
      <header class="board-head">
        <h1>Runs</h1>
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
            cells, so nothing binds a head to the value under it; seven stray
            nouns announced ahead of the list would be noise to a screen reader,
            which reads each row as one control with its facts in order. They
            appear only when there are rows to label, and the stylesheet drops
            them on a narrow viewport where the row reflows and the labels would
            be sitting over the wrong cells. */}
        <Show when={shown().length > 0}>
          <div class="row-head" aria-hidden="true">
            <span>Project</span>
            <span>Commit</span>
            <span>State</span>
            <span>Outcome</span>
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
            <Row run={run()} now={props.now} onOpen={props.onOpen} />
          )}
        </Index>
      </div>
    </section>
  );
}
