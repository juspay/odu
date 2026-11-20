import { ago } from "@odu/cordis/format";
import {
  Button,
  LaneStrip,
  PageHead,
  Pill,
  SearchInput,
  TitleTooltip,
} from "@odu/face/ui";
import {
  isActive,
  isFailing,
  runElapsedMs,
  runStatus,
} from "@odu/service-client/board";
import { createMemo, createSignal, For, Index, Show, type JSX } from "solid-js";
import { CommitRef } from "./commit";
import {
  duration,
  laneCells,
  lanesOf,
  platformShort,
  projectOf,
  scopeLabel,
} from "./format";
import type { CheckoutFrame, RunNode, RunRow } from "./types";

export { isActive, isFailing };

interface Standing {
  latest: RunRow;
  runs: number;
  nodes: readonly RunNode[];
}

export type BoardFilter = "all" | "active" | "attention";

const FILTERS: { id: BoardFilter; label: string; hint: string }[] = [
  { id: "attention", label: "Needs attention", hint: "runs with an unresolved failure or unposted status" },
  { id: "active", label: "Active", hint: "provisioning or running" },
  { id: "all", label: "All", hint: "every run in the catalog" },
];

const LEGEND: { label: string; class: string }[] = [
  { label: "passed", class: "cell hue-green" },
  { label: "running", class: "cell hue-amber" },
  { label: "failed", class: "cell hue-red" },
  { label: "errored", class: "cell hue-violet" },
  { label: "pending", class: "cell hue-grey" },
  { label: "skipped", class: "cell hue-grey cell-skipped" },
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

function searched(row: RunRow, needle: string): boolean {
  if (needle === "") return true;
  return (
    projectOf(row.repoRoot).toLowerCase().includes(needle) ||
    (row.branch ?? "").toLowerCase().includes(needle) ||
    row.repoRoot.toLowerCase().includes(needle)
  );
}

function nodesByRun(checkouts: CheckoutFrame[]): Map<string, readonly RunNode[]> {
  const out = new Map<string, readonly RunNode[]>();
  for (const checkout of checkouts) {
    if (checkout.latest !== null) out.set(checkout.latest.run.runId, checkout.latest.nodes);
  }
  return out;
}

function Row(props: {
  run: RunRow;
  nodes: readonly RunNode[];
  now: number;
  earlier: number;
  onOpen: (runId: string) => void;
}): JSX.Element {
  const status = () => runStatus(props.run);
  const lanes = createMemo(() => lanesOf(props.nodes));
  return (
    <button
      type="button"
      class="row"
      classList={{
        [`row-${props.run.state}`]: true,
        "row-red": isFailing(props.run),
      }}
      onClick={() => props.onOpen(props.run.runId)}
      title={props.run.repoRoot}
    >
      <span class="row-checkout">
        <span class="row-project">{projectOf(props.run.repoRoot)}</span>
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
      <span class="row-lanes">
        <Show
          when={props.nodes.length > 0}
          fallback={
            <span class="row-summary">
              <LaneStrip
                label="run"
                cells={[{ label: `whole run, ${status().label}`, hue: status().hue }]}
              />
            </span>
          }
        >
          <For each={lanes()}>
            {(lane) => (
              <LaneStrip
                label={lanes().length > 1 ? platformShort(lane.platform) : undefined}
                cells={laneCells(lane.nodes)}
              />
            )}
          </For>
        </Show>
        <span class="row-scope">{scopeLabel(props.run.scope)}</span>
      </span>
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
      <span class="row-took">{duration(runElapsedMs(props.run, props.now))}</span>
      <span class="row-age">
        {ago(props.run.createdAt, props.now)}
        <Show when={props.earlier > 0}>
          <span class="row-earlier">{`${props.earlier} earlier`}</span>
        </Show>
      </span>
      <TitleTooltip text={props.run.repoRoot} />
    </button>
  );
}

function createBoardViewState(): {
  filter: () => BoardFilter;
  setFilter: (next: BoardFilter) => void;
  history: () => boolean;
  setHistory: (next: (on: boolean) => boolean) => void;
  query: () => string;
  setQuery: (next: string) => void;
} {
  const [filter, setFilter] = createSignal<BoardFilter>("all");
  const [history, setHistory] = createSignal(false);
  const [query, setQuery] = createSignal("");
  return { filter, setFilter, history, setHistory, query, setQuery };
}

const boardViewState = createBoardViewState();

export function Board(props: {
  checkouts: CheckoutFrame[];
  unreadable: { repoRoot: string; message: string }[];
  rows: RunRow[];
  now: number;
  loading: boolean;
  onOpen: (runId: string) => void;
  onCreate: () => void;
  onMaintain: () => void;
}): JSX.Element {
  const work = createMemo(() => nodesByRun(props.checkouts));
  const shown = createMemo<Standing[]>(() => {
    const needle = boardViewState.query().trim().toLowerCase();
    const nodes = work();
    const admits = (run: RunRow): boolean =>
      matches(run, boardViewState.filter()) && searched(run, needle);
    if (boardViewState.history()) {
      return props.rows
        .filter(admits)
        .map((run) => ({ latest: run, runs: 1, nodes: nodes.get(run.runId) ?? [] }));
    }
    const out: Standing[] = [];
    for (const checkout of props.checkouts) {
      const latest = checkout.latest;
      if (latest === null || !admits(latest.run)) continue;
      out.push({ latest: latest.run, runs: checkout.total, nodes: latest.nodes });
    }
    return out;
  });
  const facts = createMemo(() => {
    let failing = 0;
    let running = 0;
    for (const checkout of props.checkouts) {
      const run = checkout.latest?.run;
      if (run === undefined) continue;
      if (isFailing(run)) failing += 1;
      if (isActive(run)) running += 1;
    }
    const checkouts = props.checkouts.length;
    return `${failing} failing · ${running} running · ${checkouts} checkout${checkouts === 1 ? "" : "s"}`;
  });
  return (
    <section class="screen board">
      <PageHead
        title="Runs"
        sub={facts()}
        actions={
          <Button class="btn-primary" onClick={props.onCreate}>
            New run
          </Button>
        }
      />
      <div class="toolbar">
        <SearchInput
          label="Filter by project or branch"
          value={boardViewState.query()}
          placeholder="project or branch"
          onValue={boardViewState.setQuery}
        />
        <div class="filters" role="group" aria-label="Filter runs">
          <For each={FILTERS}>
            {(entry) => (
              <Button
                title={entry.hint}
                pressed={boardViewState.filter() === entry.id}
                onClick={() => boardViewState.setFilter(entry.id)}
              >
                {entry.label}
              </Button>
            )}
          </For>
        </div>
        <Button
          title="show every run of every checkout, not just the latest"
          pressed={boardViewState.history()}
          onClick={() => boardViewState.setHistory((on) => !on)}
        >
          History
        </Button>
        <Button onClick={props.onMaintain}>Maintenance</Button>
      </div>
      <div class="board-body">
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
            No runs in the catalog yet. Start one with <code>odu ci run</code> in a
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
        <Show when={shown().length > 0}>
          <div class="board-rows">
            <div class="row-head" aria-hidden="true">
              <span>Checkout</span>
              <span>Commit</span>
              <span>Pipeline</span>
              <span>Status</span>
              <span>Attention</span>
              <span>Took</span>
              <span>Age</span>
            </div>
            <Index each={shown()}>
              {(entry) => (
                <Row
                  run={entry().latest}
                  nodes={entry().nodes}
                  now={props.now}
                  earlier={entry().runs - 1}
                  onOpen={props.onOpen}
                />
              )}
            </Index>
          </div>
          <p class="legend">
            <For each={LEGEND}>
              {(entry) => (
                <span>
                  <span class={entry.class} aria-hidden="true" />
                  {entry.label}
                </span>
              )}
            </For>
          </p>
        </Show>
      </div>
    </section>
  );
}
