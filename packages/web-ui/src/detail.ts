/**
 * ONE RUN — its work, its evidence, and the three things you can do about it.
 *
 * The controls are the point of this view, and each is one procedure call on
 * the same wire the CLI and the MCP face use:
 *
 *   - **Retry** a node. Which KIND of retry it is — a new attempt on a live
 *     coordinator, or a linked replay run — is odu's decision, not this view's,
 *     and the receipt says which happened. A browser that offered two buttons
 *     would be asking a person to make a call about a fact they cannot see.
 *   - **Cancel**, at an explicit scope. The whole run, one node, or one lane —
 *     three buttons, never one with a mode, because the request that costs the
 *     most when it is ambiguous is this one.
 *   - **Run again**, which is a NEW run of the same selection at the same
 *     commit. Distinct from retry: a retry is about this run's evidence.
 *
 * Every control reports the receipt it got, including a refusal. A control that
 * silently did nothing on a refusal would be the browser's version of the
 * failure this whole release exists to remove.
 */

import { createEffect, createMemo, For } from "solid-js";
import { button, classes, el, pill, type View, when } from "./dom";
import { bytes, duration, NODE_STATUS, OUTCOME, runRef, scopeLabel } from "./format";
import type { LogPage, LogTail, NodesFrame, RunNode, RunRow } from "./types";

/**
 * How much of a log one page holds.
 *
 * A node's log has no bound a browser can rely on — this repo's own `noisy`
 * fixture writes 200 000 lines, and a real build log is worse — so "read the
 * whole thing" is a request that can hand a `<pre>` fourteen megabytes and
 * leave the tab unresponsive with no way back. 64 KiB is the compromise the
 * numbers pick out: comfortably more than a screenful, small enough that a page
 * lands in one frame, and a round power of two so the offsets a person reads in
 * the window indicator line up with the ones an `odu logs --offset` would take.
 */
export const LOG_PAGE_BYTES = 64 * 1024;

/** What a control did, in the user's own view. `pending` is a real state: a
 *  retry that reaches a cold coordinator can take a second, and a button that
 *  looked idle would be pressed twice. */
export type ControlState =
  | { kind: "idle" }
  | { kind: "pending"; what: string }
  | { kind: "ok"; message: string }
  | { kind: "refused"; message: string };

export interface DetailControls {
  retryNode: (node: string, attempt: number) => void;
  cancelRun: () => void;
  cancelNode: (node: string) => void;
  cancelLane: (platform: string) => void;
  runAgain: () => void;
}

/** The platform half of `<namepath>@<platform>`. Read from the id rather than
 *  carried beside it — the id is the address and every face in this tree
 *  already reads it that way. */
function platformOf(nodeId: string): string {
  const at = nodeId.lastIndexOf("@");
  return at < 0 ? "" : nodeId.slice(at + 1);
}

function nodeRow(opts: {
  node: RunNode;
  selected: () => string | null;
  onSelect: (node: RunNode) => void;
  controls: DetailControls;
  busy: () => boolean;
}): View {
  const node = opts.node;
  const meta = NODE_STATUS[node.status];
  return el(
    "li",
    {
      // The status class only. There WAS a third, `"node-selected": false` —
      // a constant false, so a class that could never be applied, against a
      // rule no stylesheet here declares. It read as selection state and was
      // neither; the real one is `node-current` on the button below, which is
      // reactive and styled.
      class: classes({ node: true, [`node-${node.status}`]: true }),
    },
    el(
      "button",
      {
        type: "button",
        class: () =>
          classes({
            "node-open": true,
            "node-current": opts.selected() === node.id,
          }),
        onClick: () => opts.onSelect(node),
        // A node with no attempt has no evidence to show, and saying so beats a
        // button that opens an empty panel.
        disabled: node.attempt === 0,
        title:
          node.attempt === 0
            ? "this node has not started, so it has no output yet"
            : `read ${node.id}, attempt ${node.attempt}`,
      },
      el("span", { class: `glyph glyph-${meta.hue}` }, meta.glyph),
      el("span", { class: "node-id" }, node.id),
      node.attempt > 1
        ? el("span", { class: "node-attempt" }, `attempt ${node.attempt}`)
        : null,
      node.host === null
        ? null
        : el("span", { class: "node-host" }, node.host),
      node.durationMs === null
        ? null
        : el("span", { class: "node-duration" }, duration(node.durationMs)),
      node.exitCode === null || node.exitCode === 0
        ? null
        : el("span", { class: "node-exit" }, `exit ${node.exitCode}`),
    ),
    el(
      "span",
      { class: "node-controls" },
      button({
        label: "Retry",
        title: `retry ${node.id} — odu decides whether that is a new attempt or a linked run`,
        disabled: () => opts.busy() || node.attempt === 0,
        onClick: () => opts.controls.retryNode(node.id, node.attempt),
      }),
      button({
        label: "Cancel node",
        title: `stop ${node.id}`,
        disabled: () =>
          opts.busy() || node.status !== "running" ? true : false,
        onClick: () => opts.controls.cancelNode(node.id),
      }),
    ),
  );
}

/**
 * The log panel for the selected attempt.
 *
 * Two controls beyond "show me the tail", and each answers a question the tail
 * cannot:
 *
 *   - **Which attempt.** `RunNode.attempt` is the HIGHEST attempt recorded, and
 *     a retried node's earlier attempt holds the evidence of the failure that
 *     caused the retry — the thing a person came to read. It was reachable only
 *     by hand-editing the URL, which is not a control.
 *   - **Which part.** A log is unbounded, so it is read a window at a time and
 *     the window says where it is. See {@link LOG_PAGE_BYTES}.
 */
/** How far from the bottom still counts as "at the bottom". A few pixels of
 *  slack, because a fractional scrollHeight on a zoomed page never lands
 *  exactly on zero and a reader who never scrolled would stop being followed. */
const STICK_SLACK = 24;

function logPanel(opts: {
  node: () => RunNode | null;
  attempt: () => number | null;
  onAttempt: (attempt: number) => void;
  tail: () => LogTail | undefined;
  /** The cursored follow's accumulated text — byte-exact, unlike the bounded
   *  tail beside it. Null before the first page arrives. */
  followed: () => string | null;
  pending: () => boolean;
  error: () => Error | undefined;
  onPage: (offset: number) => void;
  page: () => LogPage | null;
}): View {
  /** Where the shown window starts, or `null` when the tail is what is shown.
   *  Read once per use rather than re-derived, so the two buttons and the
   *  indicator cannot disagree about which page is on screen. */
  const at = (): LogPage | null => opts.page();

  let pane: HTMLElement | undefined;
  /** Following the tail, until the reader scrolls away from it. */
  let stuck = true;
  const shown = createMemo(
    () => at()?.text ?? opts.followed() ?? opts.tail()?.text ?? "",
  );
  /** A new SUBJECT is a fresh request to see the newest output, not a
   *  continuation of wherever the last one was scrolled to. */
  createEffect(() => {
    opts.node()?.id;
    opts.attempt();
    stuck = true;
  });
  createEffect(() => {
    shown();
    const node = pane;
    if (node === undefined || !stuck) return;
    // On the NEXT task: Solid runs effects after render, but the `<pre>`'s text
    // is inserted by its own computation, so the height read here is only
    // correct once that has run.
    queueMicrotask(() => {
      node.scrollTop = node.scrollHeight;
    });
  });

  return el(
    "section",
    { class: "log", "aria-label": "Node output" },
    when(
      () => opts.node() === null,
      () =>
        el(
          "p",
          { class: "empty" },
          "Pick a node to read its output. Every attempt keeps its own log, so a retry never overwrites the one you are reading.",
        ),
    ),
    when(
      () => opts.node() !== null,
      () =>
        el(
          "div",
          { class: "log-body" },
          el(
            "header",
            { class: "log-head" },
            el("h3", {}, () => opts.node()?.id ?? ""),
            // The attempt picker, and only where there is a choice to make: a
            // node on its first attempt has one log, and a group of one button
            // announcing itself as a group is noise a screen reader has to read.
            when(
              () => (opts.node()?.attempt ?? 0) > 1,
              () =>
                el(
                  "span",
                  { class: "attempts", role: "group", "aria-label": "Attempt" },
                  el(For, {
                    // 1..attempt. The list is minted from the highest attempt
                    // rather than read off the wire because the wire has no
                    // list to read: `NodesFrame` carries one row per node.
                    // Every ordinal below the highest is an attempt that
                    // HAPPENED — the catalog mints them consecutively — and its
                    // log is addressed by the same key `formatLogKey` makes for
                    // the current one.
                    each: () =>
                      Array.from(
                        { length: opts.node()?.attempt ?? 0 },
                        (_, index) => index + 1,
                      ),
                    children: (n: number) =>
                      button({
                        label: `attempt ${n}`,
                        title: `read attempt ${n} of this node`,
                        pressed: () => opts.attempt() === n,
                        onClick: () => opts.onAttempt(n),
                      }),
                  }),
                ),
            ),
            el("span", { class: "log-meta" }, () => {
              const tail = opts.tail();
              if (tail === undefined) return "";
              // TWO facts, never one: `complete` says the log got its
              // producer's last word. A short log that says nothing about
              // completeness reads as a quiet recipe when it may be a lane that
              // died mid-sentence.
              return `${bytes(tail.totalBytes)}${tail.complete ? "" : " · incomplete — the producer never closed this log"}`;
            }),
            // WHERE the shown window is, in the same byte offsets the verb
            // takes. Without it "Older" and "Newer" are two buttons that change
            // the text and say nothing about what changed — and a person paging
            // through a long log has no way to tell a step that worked from one
            // that hit an end.
            when(
              () => at() !== null,
              () =>
                el("span", { class: "log-page" }, () => {
                  const page = at();
                  return page === null
                    ? ""
                    : `${bytes(page.offset)}–${bytes(page.nextOffset)} of ${bytes(page.size)}`;
                }),
            ),
            // Not "read the whole log": that request can hand a `<pre>` a
            // fourteen-megabyte string and leave the tab unresponsive, which is
            // what this button used to do. It reads the FIRST page, and the two
            // beside it move the window.
            button({
              label: "Read from the start",
              title: "read this log from its first byte, one page at a time",
              onClick: () => opts.onPage(0),
            }),
            button({
              label: "Older",
              title: "the page before this one",
              // No page shown means the tail is on screen, which has no offset
              // to step back from — the way in is "Read from the start".
              disabled: () => (at()?.offset ?? 0) <= 0,
              onClick: () =>
                opts.onPage(Math.max(0, (at()?.offset ?? 0) - LOG_PAGE_BYTES)),
            }),
            button({
              label: "Newer",
              title: "the page after this one",
              // `eof` is the verb's own word for "this page reached the end",
              // rather than an offset comparison this view would have to keep
              // true against a log that is still growing.
              disabled: () => at() === null || at()?.eof === true,
              onClick: () => opts.onPage(at()?.nextOffset ?? 0),
            }),
          ),
          when(
            () => opts.error() !== undefined,
            () => el("p", { class: "fault" }, () => String(opts.error())),
          ),
          when(
            () => opts.pending() && opts.tail() === undefined,
            () => el("p", { class: "empty" }, "Reading…"),
          ),
          el(
            "pre",
            {
              class: "log-text",
              tabindex: "0",
              ref: (node: HTMLElement) => {
                pane = node;
                // STICK unless the reader has scrolled away. `tail -f` and the
                // attach TUI both do this, and a pane that did not is a pane
                // that shows you the first screen of a log whose interesting
                // end is somewhere below the fold — which is every log anybody
                // opens a failure to read.
                node.addEventListener("scroll", () => {
                  const room = node.scrollHeight - node.scrollTop - node.clientHeight;
                  stuck = room <= STICK_SLACK;
                });
              },
            },
            // PAGE, then FOLLOW, then tail. An explicit page is what the
            // reader asked for; the follow is byte-exact and cursored; the
            // bounded tail is the last resort, and it is last because it is the
            // only one of the three that can silently show less than happened.
            () => at()?.text ?? opts.followed() ?? opts.tail()?.text ?? "",
          ),
        ),
    ),
  );
}

export function detail(opts: {
  run: () => RunRow | undefined;
  frame: () => NodesFrame | undefined;
  pending: () => boolean;
  error: () => Error | undefined;
  selected: () => RunNode | null;
  onSelect: (node: RunNode | null) => void;
  /** WHICH attempt the address names — not the node's highest. See
   *  {@link logPanel}. */
  selectedAttempt: () => number | null;
  onAttempt: (attempt: number) => void;
  tail: () => LogTail | undefined;
  /** The cursored follow's accumulated text — byte-exact, unlike the bounded
   *  tail beside it. Null before the first page arrives. */
  followed: () => string | null;
  tailPending: () => boolean;
  tailError: () => Error | undefined;
  page: () => LogPage | null;
  onPage: (offset: number) => void;
  control: () => ControlState;
  controls: DetailControls;
  onBack: () => void;
}): View {
  const busy = createMemo(() => opts.control().kind === "pending");
  const nodes = createMemo<RunNode[]>(() => [...(opts.frame()?.nodes ?? [])]);
  const lanes = createMemo(() => {
    const seen = new Set<string>();
    for (const node of nodes()) {
      const platform = platformOf(node.id);
      if (platform !== "") seen.add(platform);
    }
    return [...seen].sort();
  });
  return el(
    "section",
    { class: "detail" },
    el(
      "header",
      { class: "detail-head" },
      button({ label: "← Runs", onClick: opts.onBack }),
      el("h1", {}, () => {
        const run = opts.run();
        return run === undefined ? "run" : runRef(run.sha, run.seq);
      }),
      el("span", { class: "detail-sub" }, () => opts.run()?.repoRoot ?? ""),
      el("span", { class: "detail-scope" }, () => {
        const run = opts.run();
        return run === undefined ? "" : scopeLabel(run.scope);
      }),
      when(
        () => opts.run()?.outcome != null,
        () => {
          const outcome = opts.run()?.outcome;
          return outcome == null
            ? null
            : pill(OUTCOME[outcome].hue, OUTCOME[outcome].label);
        },
      ),
      when(
        () => opts.run()?.parentRunId != null,
        () =>
          el(
            "span",
            { class: "detail-parent" },
            () => `replay of ${opts.run()?.parentRunId ?? ""}`,
          ),
      ),
    ),
    // The run-wide controls. `Run again` is a NEW run at the same commit and
    // the same selection; `Cancel run` is this one's teardown. They sit apart
    // from the per-node controls because they are about a different subject.
    el(
      "div",
      { class: "detail-controls" },
      button({
        label: "Run again",
        title: "start a NEW run of this selection, at this commit",
        disabled: busy,
        onClick: opts.controls.runAgain,
      }),
      button({
        label: "Cancel run",
        title: "stop the whole run",
        disabled: busy,
        onClick: opts.controls.cancelRun,
      }),
      el(For, {
        each: () => lanes(),
        children: (platform: string) =>
          button({
            label: `Cancel ${platform}`,
            title: `drop the ${platform} lane; the rest of the run continues`,
            disabled: busy,
            onClick: () => opts.controls.cancelLane(platform),
          }),
      }),
    ),
    // Every control answers, including a refusal. A control that went quiet on
    // a refusal is the browser's version of the failure this release removes.
    when(
      () => opts.control().kind !== "idle",
      () =>
        el(
          "p",
          {
            class: () =>
              classes({
                receipt: true,
                "receipt-bad": opts.control().kind === "refused",
              }),
            role: "status",
          },
          () => {
            const state = opts.control();
            switch (state.kind) {
              case "idle":
                return "";
              case "pending":
                return `${state.what}…`;
              case "ok":
                return state.message;
              case "refused":
                return state.message;
            }
          },
        ),
    ),
    el(
      "div",
      { class: "detail-body" },
      el(
        "section",
        { class: "nodes", "aria-label": "Nodes" },
        when(
          () => opts.error() !== undefined,
          () => el("p", { class: "fault" }, () => String(opts.error())),
        ),
        when(
          () => opts.pending() && opts.frame() === undefined,
          () => el("p", { class: "empty" }, "Reading this run…"),
        ),
        when(
          () => opts.frame() !== undefined && nodes().length === 0,
          () =>
            el(
              "p",
              { class: "empty" },
              "This run has published no work yet — it is still claiming a machine.",
            ),
        ),
        el(
          "ul",
          { class: "node-list" },
          el(For, {
            each: () => nodes(),
            children: (node: RunNode) =>
              nodeRow({
                node,
                selected: () => opts.selected()?.id ?? null,
                onSelect: (picked) => opts.onSelect(picked),
                controls: opts.controls,
                busy,
              }),
          }),
        ),
      ),
      logPanel({
        node: opts.selected,
        attempt: opts.selectedAttempt,
        onAttempt: opts.onAttempt,
        tail: opts.tail,
        followed: opts.followed,
        pending: opts.tailPending,
        error: opts.tailError,
        onPage: opts.onPage,
        page: opts.page,
      }),
    ),
  );
}
