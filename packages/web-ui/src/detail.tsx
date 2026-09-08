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

import {
  createEffect,
  createMemo,
  For,
  Index,
  Show,
  type JSX,
} from "solid-js";
import { Button, Pill, Receipt } from "./dom";
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

function NodeRow(props: {
  node: RunNode;
  selected: string | null;
  onSelect: (node: RunNode) => void;
  controls: DetailControls;
  busy: boolean;
}): JSX.Element {
  const meta = (): (typeof NODE_STATUS)[RunNode["status"]] =>
    NODE_STATUS[props.node.status];
  return (
    <li
      // The status class only. There WAS a third, `"node-selected": false` — a
      // constant false, so a class that could never be applied, against a rule
      // no stylesheet here declares. It read as selection state and was neither;
      // the real one is `node-current` on the button below.
      class="node"
      classList={{ [`node-${props.node.status}`]: true }}
    >
      <button
        type="button"
        class="node-open"
        classList={{ "node-current": props.selected === props.node.id }}
        onClick={() => props.onSelect(props.node)}
        // A node with no attempt has no evidence to show, and saying so beats a
        // button that opens an empty panel.
        disabled={props.node.attempt === 0}
        title={
          props.node.attempt === 0
            ? "this node has not started, so it has no output yet"
            : `read ${props.node.id}, attempt ${props.node.attempt}`
        }
      >
        <span class={`glyph glyph-${meta().hue}`}>{meta().glyph}</span>
        <span class="node-id">{props.node.id}</span>
        <Show when={props.node.attempt > 1}>
          <span class="node-attempt">{`attempt ${props.node.attempt}`}</span>
        </Show>
        <Show when={props.node.host}>
          {(host) => <span class="node-host">{host()}</span>}
        </Show>
        <Show when={props.node.durationMs !== null}>
          <span class="node-duration">{duration(props.node.durationMs)}</span>
        </Show>
        <Show when={props.node.exitCode !== null && props.node.exitCode !== 0}>
          <span class="node-exit">{`exit ${props.node.exitCode ?? 0}`}</span>
        </Show>
      </button>
      <span class="node-controls">
        <Button
          title={`retry ${props.node.id} — odu decides whether that is a new attempt or a linked run`}
          disabled={props.busy || props.node.attempt === 0}
          onClick={() => props.controls.retryNode(props.node.id, props.node.attempt)}
        >
          Retry
        </Button>
        <Button
          title={`stop ${props.node.id}`}
          disabled={props.busy || props.node.status !== "running"}
          onClick={() => props.controls.cancelNode(props.node.id)}
        >
          Cancel node
        </Button>
      </span>
    </li>
  );
}

/** How far from the bottom still counts as "at the bottom". A few pixels of
 *  slack, because a fractional scrollHeight on a zoomed page never lands
 *  exactly on zero and a reader who never scrolled would stop being followed. */
const STICK_SLACK = 24;

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
function LogPanel(props: {
  node: RunNode | null;
  attempt: number | null;
  onAttempt: (attempt: number) => void;
  tail: LogTail | undefined;
  /** The cursored follow's accumulated text — byte-exact, unlike the bounded
   *  tail beside it. Null before the first page arrives. */
  followed: string | null;
  /** Why the follow stopped, when it did — shown beside the log rather than
   *  swallowed, because a pane that has quietly stopped updating looks exactly
   *  like a log that has quietly stopped growing. */
  followFault: string | null;
  pending: boolean;
  error: Error | undefined;
  onPage: (offset: number) => void;
  page: LogPage | null;
}): JSX.Element {
  /** Where the shown window starts, or `null` when the tail is what is shown.
   *  Read through one accessor rather than re-derived, so the two buttons and
   *  the indicator cannot disagree about which page is on screen. */
  const at = (): LogPage | null => props.page;

  let pane: HTMLPreElement | undefined;
  /** Following the tail, until the reader scrolls away from it. */
  let stuck = true;

  // PAGE, then FOLLOW, then tail. An explicit page is what the reader asked
  // for; the follow is byte-exact and cursored; the bounded tail is the last
  // resort, and it is last because it is the only one of the three that can
  // silently show less than happened.
  //
  // UNLESS THE FOLLOW HAS STOPPED. A follow that has given up holds the bytes
  // it had when it stopped, and preferring them over a live tail freezes the
  // pane while the wire, the header and the board all recover around it —
  // which is the one state a reader cannot distinguish from "the log stopped
  // growing". When the follow is faulted the tail is the fresher of the two,
  // so it wins, and the sentence beside the pane says why.
  const shown = createMemo(() => {
    const paged = at()?.text;
    if (paged !== undefined) return paged;
    const following = props.followFault === null ? props.followed : null;
    return following ?? props.tail?.text ?? "";
  });

  /** A new SUBJECT is a fresh request to see the newest output, not a
   *  continuation of wherever the last one was scrolled to. */
  createEffect(() => {
    props.node?.id;
    props.attempt;
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

  return (
    <section class="log" aria-label="Node output">
      <Show
        when={props.node}
        fallback={
          <p class="empty">
            Pick a node to read its output. Every attempt keeps its own log, so a
            retry never overwrites the one you are reading.
          </p>
        }
      >
        {(node) => (
          <div class="log-body">
            <header class="log-head">
              <h3>{node().id}</h3>
              {/* The attempt picker, and only where there is a choice to make:
                  a node on its first attempt has one log, and a group of one
                  button announcing itself as a group is noise a screen reader
                  has to read. */}
              <Show when={node().attempt > 1}>
                <span class="attempts" role="group" aria-label="Attempt">
                  {/* 1..attempt. The list is minted from the highest attempt
                      rather than read off the wire because the wire has no list
                      to read: `NodesFrame` carries one row per node. Every
                      ordinal below the highest is an attempt that HAPPENED —
                      the catalog mints them consecutively — and its log is
                      addressed by the same key `formatLogKey` makes for the
                      current one. */}
                  <Index
                    each={Array.from(
                      { length: node().attempt },
                      (_, index) => index + 1,
                    )}
                  >
                    {(n) => (
                      <Button
                        title={`read attempt ${n()} of this node`}
                        pressed={props.attempt === n()}
                        onClick={() => props.onAttempt(n())}
                      >
                        {`attempt ${n()}`}
                      </Button>
                    )}
                  </Index>
                </span>
              </Show>
              <span class="log-meta">
                {/* TWO facts, never one: `complete` says the log got its
                    producer's last word. A short log that says nothing about
                    completeness reads as a quiet recipe when it may be a lane
                    that died mid-sentence. */}
                {props.tail === undefined
                  ? ""
                  : `${bytes(props.tail.totalBytes)}${props.tail.complete ? "" : " · incomplete — the producer never closed this log"}`}
              </span>
              {/* WHERE the shown window is, in the same byte offsets the verb
                  takes. Without it "Older" and "Newer" are two buttons that
                  change the text and say nothing about what changed — and a
                  person paging through a long log has no way to tell a step that
                  worked from one that hit an end. */}
              <Show when={at()}>
                {(page) => (
                  <span class="log-page">
                    {`${bytes(page().offset)}–${bytes(page().nextOffset)} of ${bytes(page().size)}`}
                  </span>
                )}
              </Show>
              {/* Not "read the whole log": that request can hand a `<pre>` a
                  fourteen-megabyte string and leave the tab unresponsive, which
                  is what this button used to do. It reads the FIRST page, and
                  the two beside it move the window. */}
              <Button
                title="read this log from its first byte, one page at a time"
                onClick={() => props.onPage(0)}
              >
                Read from the start
              </Button>
              <Button
                title="the page before this one"
                // No page shown means the tail is on screen, which has no offset
                // to step back from — the way in is "Read from the start".
                disabled={(at()?.offset ?? 0) <= 0}
                onClick={() =>
                  props.onPage(Math.max(0, (at()?.offset ?? 0) - LOG_PAGE_BYTES))
                }
              >
                Older
              </Button>
              <Button
                title="the page after this one"
                // `eof` is the verb's own word for "this page reached the end",
                // rather than an offset comparison this view would have to keep
                // true against a log that is still growing.
                disabled={at() === null || at()?.eof === true}
                onClick={() => props.onPage(at()?.nextOffset ?? 0)}
              >
                Newer
              </Button>
            </header>
            <Show when={props.error}>
              {(error) => <p class="fault">{String(error())}</p>}
            </Show>
            <Show when={props.pending && props.tail === undefined}>
              <p class="empty">Reading…</p>
            </Show>
            {/* A stopped follow SAYS SO. Swallowing it left a pane that had
                quietly stopped updating looking exactly like a log that had
                quietly stopped growing — the same silent-loss failure the
                cursored follow exists to remove, one layer up. */}
            <Show when={props.followFault}>
              {(fault) => <p class="fault">{fault()}</p>}
            </Show>
            <pre
              class="log-text"
              tabindex="0"
              ref={pane}
              // STICK unless the reader has scrolled away. `tail -f` and the
              // attach TUI both do this, and a pane that did not is a pane that
              // shows you the first screen of a log whose interesting end is
              // somewhere below the fold — which is every log anybody opens a
              // failure to read.
              onScroll={(event) => {
                const el = event.currentTarget;
                stuck = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLACK;
              }}
            >
              {shown()}
            </pre>
          </div>
        )}
      </Show>
    </section>
  );
}

export function Detail(props: {
  run: RunRow | undefined;
  frame: NodesFrame | undefined;
  pending: boolean;
  error: Error | undefined;
  selected: RunNode | null;
  onSelect: (node: RunNode | null) => void;
  /** WHICH attempt the address names — not the node's highest. See
   *  {@link LogPanel}. */
  selectedAttempt: number | null;
  onAttempt: (attempt: number) => void;
  tail: LogTail | undefined;
  /** The cursored follow's accumulated text — byte-exact, unlike the bounded
   *  tail beside it. Null before the first page arrives. */
  followed: string | null;
  /** Why the follow stopped, when it did — shown beside the log rather than
   *  swallowed, because a pane that has quietly stopped updating looks exactly
   *  like a log that has quietly stopped growing. */
  followFault: string | null;
  tailPending: boolean;
  tailError: Error | undefined;
  page: LogPage | null;
  onPage: (offset: number) => void;
  control: ControlState;
  controls: DetailControls;
  onBack: () => void;
}): JSX.Element {
  const busy = createMemo(() => props.control.kind === "pending");
  const nodes = createMemo<RunNode[]>(() => [...(props.frame?.nodes ?? [])]);
  const lanes = createMemo(() => {
    const seen = new Set<string>();
    for (const node of nodes()) {
      const platform = platformOf(node.id);
      if (platform !== "") seen.add(platform);
    }
    return [...seen].sort();
  });
  return (
    <section class="detail">
      <header class="detail-head">
        <Button onClick={props.onBack}>← Runs</Button>
        <h1>{props.run === undefined ? "run" : runRef(props.run.sha, props.run.seq)}</h1>
        <span class="detail-sub">{props.run?.repoRoot ?? ""}</span>
        <span class="detail-scope">
          {props.run === undefined ? "" : scopeLabel(props.run.scope)}
        </span>
        <Show when={props.run?.outcome}>
          {(outcome) => (
            <Pill hue={OUTCOME[outcome()].hue}>{OUTCOME[outcome()].label}</Pill>
          )}
        </Show>
        <Show when={props.run?.parentRunId}>
          {(parent) => (
            <span class="detail-parent">{`replay of ${parent()}`}</span>
          )}
        </Show>
      </header>
      {/* The run-wide controls. `Run again` is a NEW run at the same commit and
          the same selection; `Cancel run` is this one's teardown. They sit apart
          from the per-node controls because they are about a different
          subject. */}
      <div class="detail-controls">
        <Button
          title="start a NEW run of this selection, at this commit"
          disabled={busy()}
          onClick={props.controls.runAgain}
        >
          Run again
        </Button>
        <Button
          title="stop the whole run"
          disabled={busy()}
          onClick={props.controls.cancelRun}
        >
          Cancel run
        </Button>
        {/* `For`, not `Index`: a lane list is a sorted set of platform names, so
            a name IS its own identity and keying by value is what keeps a
            button attached to the lane it cancels. */}
        <For each={lanes()}>
          {(platform) => (
            <Button
              title={`drop the ${platform} lane; the rest of the run continues`}
              disabled={busy()}
              onClick={() => props.controls.cancelLane(platform)}
            >
              {`Cancel ${platform}`}
            </Button>
          )}
        </For>
      </div>
      {/* Every control answers, including a refusal. A control that went quiet
          on a refusal is the browser's version of the failure this release
          removes. */}
      <Show when={props.control.kind !== "idle"}>
        <Receipt role="status" bad={props.control.kind === "refused"}>
          {receiptText(props.control)}
        </Receipt>
      </Show>
      <div class="detail-body">
        <section class="nodes" aria-label="Nodes">
          <Show when={props.error}>
            {(error) => <p class="fault">{String(error())}</p>}
          </Show>
          <Show when={props.pending && props.frame === undefined}>
            <p class="empty">Reading this run…</p>
          </Show>
          <Show when={props.frame !== undefined && nodes().length === 0}>
            <p class="empty">
              This run has published no work yet — it is still claiming a
              machine.
            </p>
          </Show>
          <ul class="node-list">
            {/* `Index`, not `For`. A `NodesFrame` is re-sent WHOLE on every
                change, so every node object is a new reference every tick;
                keying by reference would rebuild every row of a running DAG
                several times a second and take the focus off whichever control
                a person was about to press. */}
            <Index each={nodes()}>
              {(node) => (
                <NodeRow
                  node={node()}
                  selected={props.selected?.id ?? null}
                  onSelect={props.onSelect}
                  controls={props.controls}
                  busy={busy()}
                />
              )}
            </Index>
          </ul>
        </section>
        <LogPanel
          node={props.selected}
          attempt={props.selectedAttempt}
          onAttempt={props.onAttempt}
          tail={props.tail}
          followed={props.followed}
          followFault={props.followFault}
          pending={props.tailPending}
          error={props.tailError}
          onPage={props.onPage}
          page={props.page}
        />
      </div>
    </section>
  );
}

/** What a control's receipt says. A total switch rather than a lookup, so a new
 *  control state is a compile error here rather than a blank line on the page. */
function receiptText(state: ControlState): string {
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
}
