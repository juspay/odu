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

import { createMemo, createSignal, For, Show } from "solid-js";
import { button, classes, el, pill, type View } from "./dom";
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
 *  `./dom`'s `button`, which is where that decision is made once. */
function row(opts: {
  run: RunRow;
  now: () => number;
  onOpen: (runId: string) => void;
}): View {
  const run = opts.run;
  const state = BOARD_STATE[run.state];
  return el(
    "button",
    {
      type: "button",
      class: classes({
        row: true,
        [`row-${run.state}`]: true,
        "row-red": run.unresolvedFailures > 0,
      }),
      onClick: () => opts.onOpen(run.runId),
      // The whole path, because two worktrees of one repo share a last segment
      // and the difference is exactly what a multi-worktree board is for.
      title: run.repoRoot,
    },
    el(
      "span",
      { class: "row-project" },
      projectOf(run.repoRoot),
      run.branch === null
        ? null
        : el("span", { class: "row-branch" }, run.branch),
    ),
    el(
      "span",
      { class: "row-sha" },
      runRef(run.sha, run.seq),
      run.dirty ? el("span", { class: "row-dirty" }, "+dirty") : null,
    ),
    el("span", { class: "row-state" }, pill(state.hue, state.label)),
    el(
      "span",
      { class: "row-outcome" },
      run.outcome === null ? null : pill(OUTCOME[run.outcome].hue, OUTCOME[run.outcome].label),
    ),
    el(
      "span",
      { class: "row-attention" },
      run.unresolvedFailures === 0
        ? null
        : pill(
            "red",
            `${run.unresolvedFailures} failing`,
          ),
      run.reportingDebt === 0
        ? null
        : pill("amber", `${run.reportingDebt} unposted`),
    ),
    el("span", { class: "row-scope" }, scopeLabel(run.scope)),
    el("span", { class: "row-age" }, () => ago(run.createdAt, opts.now())),
  );
}

/**
 * The board.
 *
 * `rows` is an accessor rather than an array: the collection is live, and a
 * view that took a snapshot would show the catalog as it was when the page
 * loaded. `now` likewise — the ages tick without the rows moving.
 */
export function board(opts: {
  rows: () => RunRow[];
  now: () => number;
  loading: () => boolean;
  onOpen: (runId: string) => void;
  onCreate: () => void;
}): View {
  const [filter, setFilter] = createSignal<BoardFilter>("all");
  const shown = createMemo(() =>
    opts.rows().filter((run) => matches(run, filter())),
  );
  return el(
    "section",
    { class: "board" },
    el(
      "header",
      { class: "board-head" },
      el("h1", {}, "Runs"),
      el(
        "div",
        { class: "filters", role: "group", "aria-label": "Filter runs" },
        // Spelled here rather than through `./dom`'s `button`, for the one
        // thing that helper does not carry: `aria-pressed`. Which filter is
        // ACTIVE is state, and state a sighted person reads off a highlight has
        // to be in the DOM for everybody else — so it rides the element rather
        // than a class name.
        ...FILTERS.map((entry) =>
          el(
            "button",
            {
              type: "button",
              class: "btn",
              title: entry.hint,
              "aria-pressed": () => String(filter() === entry.id),
              onClick: () => setFilter(entry.id),
            },
            entry.label,
          ),
        ),
      ),
      button({ label: "New run", onClick: opts.onCreate, className: "btn btn-primary" }),
    ),
    // Three states, told apart. "Nothing yet" and "nothing MATCHING" are
    // different answers, and a board that showed one blank panel for both would
    // send somebody looking for a run that is right there under another filter.
    el(
      "div",
      { class: "board-body" },
      el(Show, {
        when: () => opts.loading(),
        children: el("p", { class: "empty" }, "Reading the catalog…"),
      }),
      el(Show, {
        when: () => !opts.loading() && opts.rows().length === 0,
        children: el(
          "p",
          { class: "empty" },
          "No runs in the catalog yet. Start one with ",
          el("code", {}, "odu run"),
          " in a checkout, or with the button above.",
        ),
      }),
      el(Show, {
        when: () =>
          !opts.loading() && opts.rows().length > 0 && shown().length === 0,
        children: el(
          "p",
          { class: "empty" },
          "No runs match this filter — every run in the catalog is quiet.",
        ),
      }),
      el(For, {
        each: () => shown(),
        children: (run: RunRow) =>
          row({ run, now: opts.now, onOpen: opts.onOpen }),
      }),
    ),
  );
}
