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
 * By DEFAULT the board is one row per checkout — the run each checkout STANDS
 * FOR — and everything else is behind the History toggle. A person with four
 * checkouts asks "what is my CI doing", and forty rows of superseded history is
 * the same question left unanswered.
 *
 * The collapse itself is not here and is not the view's: `streams.checkout`
 * answers "which run stands for this checkout, and how many are behind it" on
 * the catalog's own clock, and this view paints what it is handed. What is left
 * here is the narrowing a PERSON asked for — the bucket chips, the search box,
 * History — applied to the run each checkout stands for.
 *
 * Nothing here computes a verdict. Every field is the service's own row; the
 * view sorts, filters and words it.
 */

import {
  isActive,
  isFailing,
  runStatus,
} from "@odu/service-client/board";
import { createMemo, createSignal, For, Index, Show, type JSX } from "solid-js";
import { Button, CommitRef, Hint, Pill } from "./dom";
import { ago, projectOf, scopeLabel } from "./format";
import type { CheckoutFrame, RunRow } from "./types";

/** Re-exported so `./board` stays the one import path this app's own modules
 *  use: the readings themselves live in `@odu/service-client/board`, which is
 *  where a second face reads them from too. */
export { isActive, isFailing };

/** One painted row: the run it stands for, and how many runs it stands FOR.
 *  A view shape — in History the two are one run and itself. */
interface Standing {
  latest: RunRow;
  runs: number;
}

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
      return isActive(row);
    case "attention":
      return isFailing(row) || row.reportingDebt > 0;
  }
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
  const status = () => runStatus(props.run);
  return (
    <button
      type="button"
      class="row"
      classList={{
        [`row-${props.run.state}`]: true,
        "row-red": isFailing(props.run),
      }}
      onClick={() => props.onOpen(props.run.runId)}
      // The whole path, because two worktrees of one repo share a last segment
      // and the difference is exactly what a multi-worktree board is for.
      title={props.run.repoRoot}
    >
      <span class="row-project">
        {projectOf(props.run.repoRoot)}
        <Show when={props.run.branch}>
          {(branch) => <span class="branch">{branch()}</span>}
        </Show>
      </span>
      <span class="row-sha">
        <CommitRef
          sha={props.run.sha}
          seq={props.run.seq}
          dirty={props.run.dirty}
          contentSha={props.run.contentSha}
        />
      </span>
      {/* ONE status cell, not two — the fold (verdict once there is one, where
          the run has got to until then) is `@odu/service-client/board`'s
          `runStatus`, so every face of a row wears the same word. */}
      <span class="row-status">
        <Pill hue={status().hue}>{status().label}</Pill>
      </span>
      <span class="row-attention">
        <Show when={isFailing(props.run)}>
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
      {/* The drawn half of the `title` above — the checkout path, which is
          arguably the most useful hint on this board and used to be the only
          one drawn by the browser's own slow tooltip, because this control is
          hand-spelled rather than built from `Button`. A `.tip` is
          `display: none` until hovered, and a `display: none` child is not a
          grid item, so the six-column row does not move. */}
      <Hint text={props.run.repoRoot} />
    </button>
  );
}

/** HOW THE BOARD WAS LEFT. Module-scope rather than component-scope because
 *  `app.tsx`'s `Switch` rebuilds this branch on every entry (see its header),
 *  and a filter you set, walked into a run from, and came back to should still
 *  be set. There is one board, so there is one of each. */
const [filter, setFilter] = createSignal<BoardFilter>("all");
const [history, setHistory] = createSignal(false);
const [query, setQuery] = createSignal("");

/**
 * The board.
 *
 * `checkouts`, `rows` and `now` are plain values, and they stay live because
 * the compiler turns a dynamic JSX prop into a getter on this component's
 * `props` — see `./dom`'s header. So the ages tick without the rows moving, and
 * a catalog update repaints the cells it changed rather than the list.
 */
export function Board(props: {
  /** One frame per checkout on the board, newest checkout first — the service's
   *  own collapse, which this view paints rather than performs. */
  checkouts: CheckoutFrame[];
  /** The checkouts whose reading FAILED, with the reason. A board that showed
   *  only the ones it could read would answer "what is my CI doing here" with
   *  silence about the one checkout it could not answer for — while History
   *  below still lists that checkout's runs. */
  unreadable: { repoRoot: string; message: string }[];
  /** Every run, newest first. The History list, and nothing else: with the
   *  collapse off the wire, this is the only thing left that wants them. */
  rows: RunRow[];
  now: number;
  loading: boolean;
  onOpen: (runId: string) => void;
  onCreate: () => void;
}): JSX.Element {
  const shown = createMemo<Standing[]>(() => {
    const needle = query().trim().toLowerCase();
    const admits = (run: RunRow): boolean =>
      matches(run, filter()) && searched(run, needle);
    // History folds nothing away, so every run is its own row and there is
    // nothing for a row to stand for.
    if (history()) {
      return props.rows
        .filter(admits)
        .map((run) => ({ latest: run, runs: 1 }));
    }
    // THE NARROWING IS ASKED OF THE RUN THE CHECKOUT STANDS FOR, and that is
    // the whole meaning of "needs attention": the bucket is about what is
    // CURRENTLY wrong with a checkout, and a superseded run's red is history.
    // Admitting a checkout because some older run of it failed would leave one
    // you fixed an hour ago in the attention bucket forever.
    const out: Standing[] = [];
    for (const checkout of props.checkouts) {
      const latest = checkout.latest?.run;
      // A checkout whose every run aged out of the catalog has nothing to
      // stand for — no row, rather than an empty one.
      if (latest === undefined || !admits(latest)) continue;
      // The count is the catalog's own total, so "N earlier" is a promise
      // History keeps.
      out.push({ latest, runs: checkout.total });
    }
    return out;
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
          title="show every run of every checkout, not just the latest"
          pressed={history()}
          onClick={() => setHistory((on) => !on)}
        >
          History
        </Button>
        <Button class="btn-primary" onClick={props.onCreate}>
          New run
        </Button>
      </header>
      {/* Three states, told apart. "Nothing yet" and "nothing MATCHING" are
          different answers, and a board that showed one blank panel for both
          would send somebody looking for a run that is right there under
          another filter. */}
      <div class="board-body">
        {/* ABOVE the rows and outside every filter: this is not a run state
            that a bucket could be about, it is the board failing to read a
            checkout, and the person it concerns is whoever is looking now. */}
        <For each={props.unreadable}>
          {(checkout) => (
            <p class="fault" role="alert">
              {projectOf(checkout.repoRoot)} could not be read —{" "}
              {checkout.message}
            </p>
          )}
        </For>
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
          {(entry) => (
            <Row
              run={entry().latest}
              now={props.now}
              earlier={entry().runs - 1}
              onOpen={props.onOpen}
            />
          )}
        </Index>
      </div>
    </section>
  );
}
