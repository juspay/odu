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

import { createMemo, createSignal, For, Show } from "solid-js";
import { button, classes, el, pill, type View } from "./dom";
import { bytes, duration, NODE_STATUS, OUTCOME, runRef, scopeLabel } from "./format";
import type { LogTail, NodesFrame, RunNode, RunRow } from "./types";

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
      class: classes({
        node: true,
        [`node-${node.status}`]: true,
        "node-selected": false,
      }),
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

/** The log panel for the selected attempt. */
function logPanel(opts: {
  node: () => RunNode | null;
  tail: () => LogTail | undefined;
  pending: () => boolean;
  error: () => Error | undefined;
  onFullPage: () => void;
  page: () => string | null;
}): View {
  return el(
    "section",
    { class: "log", "aria-label": "Node output" },
    el(Show, {
      when: () => opts.node() === null,
      children: el(
        "p",
        { class: "empty" },
        "Pick a node to read its output. Every attempt keeps its own log, so a retry never overwrites the one you are reading.",
      ),
    }),
    el(Show, {
      when: () => opts.node() !== null,
      children: el(
        "div",
        { class: "log-body" },
        el(
          "header",
          { class: "log-head" },
          el("h3", {}, () => opts.node()?.id ?? ""),
          el("span", { class: "log-meta" }, () => {
            const tail = opts.tail();
            if (tail === undefined) return "";
            // TWO facts, never one: `complete` says the log got its producer's
            // last word. A short log that says nothing about completeness reads
            // as a quiet recipe when it may be a lane that died mid-sentence.
            return `${bytes(tail.totalBytes)}${tail.complete ? "" : " · incomplete — the producer never closed this log"}`;
          }),
          button({ label: "Read whole log", onClick: opts.onFullPage }),
        ),
        el(Show, {
          when: () => opts.error() !== undefined,
          children: el("p", { class: "fault" }, () => String(opts.error())),
        }),
        el(Show, {
          when: () => opts.pending() && opts.tail() === undefined,
          children: el("p", { class: "empty" }, "Reading…"),
        }),
        el(
          "pre",
          { class: "log-text", tabindex: "0" },
          () => opts.page() ?? opts.tail()?.text ?? "",
        ),
      ),
    }),
  );
}

export function detail(opts: {
  run: () => RunRow | undefined;
  frame: () => NodesFrame | undefined;
  pending: () => boolean;
  error: () => Error | undefined;
  selected: () => RunNode | null;
  onSelect: (node: RunNode | null) => void;
  tail: () => LogTail | undefined;
  tailPending: () => boolean;
  tailError: () => Error | undefined;
  page: () => string | null;
  onFullPage: () => void;
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
      el(Show, {
        when: () => opts.run()?.outcome != null,
        children: () => {
          const outcome = opts.run()?.outcome;
          return outcome == null
            ? null
            : pill(OUTCOME[outcome].hue, OUTCOME[outcome].label);
        },
      }),
      el(Show, {
        when: () => opts.run()?.parentRunId != null,
        children: el(
          "span",
          { class: "detail-parent" },
          () => `replay of ${opts.run()?.parentRunId ?? ""}`,
        ),
      }),
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
    el(Show, {
      when: () => opts.control().kind !== "idle",
      children: el(
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
    }),
    el(
      "div",
      { class: "detail-body" },
      el(
        "section",
        { class: "nodes", "aria-label": "Nodes" },
        el(Show, {
          when: () => opts.error() !== undefined,
          children: el("p", { class: "fault" }, () => String(opts.error())),
        }),
        el(Show, {
          when: () => opts.pending() && opts.frame() === undefined,
          children: el("p", { class: "empty" }, "Reading this run…"),
        }),
        el(Show, {
          when: () => opts.frame() !== undefined && nodes().length === 0,
          children: el(
            "p",
            { class: "empty" },
            "This run has published no work yet — it is still claiming a machine.",
          ),
        }),
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
        tail: opts.tail,
        pending: opts.tailPending,
        error: opts.tailError,
        onFullPage: opts.onFullPage,
        page: opts.page,
      }),
    ),
  );
}
