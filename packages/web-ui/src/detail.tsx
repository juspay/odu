/**
 * ONE RUN — its work, its evidence, and the things you can do about it.
 *
 * The controls are the point of this view, and each is one procedure call on
 * the same wire the CLI and the MCP face use:
 *
 *   - **Retry** a node. Which KIND of retry it is — a new attempt on a live
 *     coordinator, or a linked replay run — is odu's decision, not this view's,
 *     and the receipt says which happened. A browser that offered two buttons
 *     would be asking a person to make a call about a fact they cannot see.
 *   - **Cancel**, at an explicit scope. The whole run, one lane, or one node —
 *     three controls, never one with a mode, because the request that costs the
 *     most when it is ambiguous is this one. Each sits where its scope is drawn:
 *     the run's beside the run's header, a lane's on the lane, a node's on the
 *     node — so the thing that is about to stop is the thing you are pointing
 *     at. Only the whole-run one is guarded by a confirmation; the other two are
 *     scoped, and the run continues around them.
 *   - **Run again**, which is a NEW run of the same selection at the same
 *     commit. Distinct from retry: a retry is about this run's evidence.
 *
 * A per-node control is rendered ONLY where it applies. A disabled button that
 * can never be pressed is noise, and a control's absence is the honest statement
 * that the action does not apply here — so a node that has not started offers
 * neither, one that has stopped offers Retry, and a running one offers Cancel
 * node.
 *
 * Every control reports the receipt it got, including a refusal. A control that
 * silently did nothing on a refusal would be the browser's version of the
 * failure this whole release exists to remove.
 */

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  Show,
  type JSX,
} from "solid-js";
import { ansiClass, ansiColor, ansiSpans } from "./ansi";
import { Button, Confirm, Pill, Receipt } from "./dom";
import {
  bytes,
  duration,
  NODE_STATUS,
  OUTCOME,
  projectOf,
  runRef,
  scopeLabel,
} from "./format";
import type {
  LogPage,
  LogTail,
  NodesFrame,
  NodeStatus,
  RunNode,
  RunRow,
} from "./types";

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
  /** Put the receipt away. An answer that has been READ is clutter over the
   *  work — and the state it clears is the same one every control above sets,
   *  which lives in `app.tsx`, so this view asks rather than keeping a second
   *  copy of it. */
  dismiss: () => void;
}

/** The platform half of `<namepath>@<platform>`. Read from the id rather than
 *  carried beside it — the id is the address and every face in this tree
 *  already reads it that way. */
function platformOf(nodeId: string): string {
  const at = nodeId.lastIndexOf("@");
  return at < 0 ? "" : nodeId.slice(at + 1);
}

/** The statuses a lane counts, in the vocabulary's own order — so two lanes read
 *  left to right the same way whatever each of them happens to hold. */
const STATUS_ORDER = Object.keys(NODE_STATUS) as NodeStatus[];

/**
 * A LANE'S HEADER — one platform's worth of the DAG, named.
 *
 * A run's nodes arrive as one flat list whose only clue about which machine a
 * row belongs to is the `@platform` suffix at the end of an id that is already
 * too long to scan. Grouping them puts the three facts a person wants about a
 * lane — which platform, which machine, how far along — in one row above the
 * work, and puts the button that drops the lane ON the lane rather than in a bar
 * of near-identical buttons at the top of the page.
 */
function LaneHead(props: {
  platform: string;
  nodes: readonly RunNode[];
  controls: DetailControls;
  busy: boolean;
}): JSX.Element {
  /** The machines this lane is actually on. Usually one; more than one is a lane
   *  that changed hosts mid-run, which is worth seeing rather than averaging
   *  away. */
  const hosts = (): string[] => [
    ...new Set(
      props.nodes
        .map((node) => node.host)
        .filter((host): host is string => host !== null && host !== ""),
    ),
  ];
  const counts = (): { status: NodeStatus; count: number }[] => {
    const out: { status: NodeStatus; count: number }[] = [];
    for (const status of STATUS_ORDER) {
      const count = props.nodes.filter((node) => node.status === status).length;
      if (count > 0) out.push({ status, count });
    }
    return out;
  };
  return (
    <li class="lane">
      {/* A node id with no `@` names no platform. It should not happen — the
          coordinator mints every id with one — and saying so beats heading a
          group with an empty string. */}
      <span class="lane-platform">
        {props.platform === "" ? "(no platform)" : props.platform}
      </span>
      {/* No host yet is a FACT about the lane rather than a blank: it is waiting
          on a machine, which is the state people mistake for a run that is
          stuck. */}
      <span class="lane-host">
        {hosts().length === 0 ? "claiming a machine" : hosts().join(", ")}
      </span>
      {/* How far along, in the same glyph vocabulary the rows below use — and
          each count carries its status in WORDS as a hint, because a glyph and a
          hue together are still not a sentence. */}
      <span class="lane-counts">
        <For each={counts()}>
          {(entry) => (
            <span title={`${entry.count} ${entry.status}`}>
              <span class={`glyph glyph-${NODE_STATUS[entry.status].hue}`}>
                {NODE_STATUS[entry.status].glyph}
              </span>
              {entry.count}
            </span>
          )}
        </For>
      </span>
      {/* A lane with no platform has no lane to cancel: `run.cancel` addresses a
          lane BY platform, so the button here would name nothing. */}
      <Show when={props.platform !== ""}>
        <Button
          title={`drop the ${props.platform} lane; the rest of the run continues`}
          disabled={props.busy}
          onClick={() => props.controls.cancelLane(props.platform)}
        >
          {`Cancel ${props.platform}`}
        </Button>
      </Show>
    </li>
  );
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
      {/* ONLY WHERE THEY APPLY. These two used to be on every row and disabled on
          most of them. A disabled button that can never be pressed is noise, and
          a control's absence is the honest statement that the action does not
          apply: Retry needs an attempt to retry and a node that has stopped;
          Cancel node needs something running to stop. */}
      <span class="node-controls">
        <Show
          when={
            props.node.attempt > 0 &&
            props.node.status !== "running" &&
            props.node.status !== "pending"
          }
        >
          <Button
            title={`retry ${props.node.id} — odu decides whether that is a new attempt or a linked run`}
            disabled={props.busy}
            onClick={() =>
              props.controls.retryNode(props.node.id, props.node.attempt)
            }
          >
            Retry
          </Button>
        </Show>
        <Show when={props.node.status === "running"}>
          <Button
            title={`stop ${props.node.id}`}
            disabled={props.busy}
            onClick={() => props.controls.cancelNode(props.node.id)}
          >
            Cancel node
          </Button>
        </Show>
      </span>
    </li>
  );
}

/** How far from the bottom still counts as "at the bottom". A few pixels of
 *  slack, because a fractional scrollHeight on a zoomed page never lands
 *  exactly on zero and a reader who never scrolled would stop being followed. */
const STICK_SLACK = 24;

/** Where the WRAP choice is remembered. Per browser rather than per run: it is a
 *  preference about how somebody reads logs, not a fact about this one. */
const WRAP_KEY = "odu.web.logWrap";

/** Storage MAY THROW — a private window, a browser set to block site data, a
 *  full quota — and a reading preference is never worth a blank page, so both
 *  directions are guarded and the default is the honest one: off, because
 *  wrapping a log line changes what it says. */
function readWrap(): boolean {
  try {
    return globalThis.localStorage?.getItem(WRAP_KEY) === "1";
  } catch {
    return false;
  }
}

function writeWrap(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(WRAP_KEY, on ? "1" : "0");
  } catch {
    // Nothing to do and nothing to say: the toggle still works for this page,
    // it just will not be remembered for the next one.
  }
}

/**
 * The log panel for the selected attempt.
 *
 * Three questions the raw tail cannot answer, and one control each:
 *
 *   - **Which attempt.** `RunNode.attempt` is the HIGHEST attempt recorded, and
 *     a retried node's earlier attempt holds the evidence of the failure that
 *     caused the retry — the thing a person came to read. It was reachable only
 *     by hand-editing the URL, which is not a control.
 *   - **Which part.** A log is unbounded, so it is read a window at a time and
 *     the window says where it is. See {@link LOG_PAGE_BYTES}.
 *   - **Am I still following it.** A pane that stopped moving because the reader
 *     scrolled up and a pane that stopped moving because the recipe went quiet
 *     look exactly alike, so the footer says which — and offers the way back.
 *
 * The paging controls, the window readout and the follow state live in a FOOTER
 * under the pane rather than in the header over it, for the reason a book puts
 * its page number at the bottom: they are what you reach for once you have run
 * out of text, and somebody who has just scrolled to the end of a failure should
 * not have to travel back up past it to ask for the next window.
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
  /** Following the tail, until the reader scrolls away from it. A SIGNAL rather
   *  than a plain local, because the footer now DRAWS it: the fact was always
   *  here, it simply had no way of reaching the page. */
  const [stuck, setStuck] = createSignal(true);
  /** Long lines wrapped rather than scrolled. Off by default, and remembered. */
  const [wrap, setWrap] = createSignal(readWrap());

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

  /** The text as the recipe COLOURED it. Memoised on `shown()`, so a re-render
   *  that changes nothing else does not re-scan the page.
   *
   *  What is drawn and what is deliberately thrown away — cursor motion,
   *  backgrounds, and a bare `\r` approximated as "start this line over", which
   *  discards whatever preceded it on that line — is all in `./ansi`'s header.
   *  This view only draws what that module returns. */
  const spans = createMemo(() => ansiSpans(shown()));

  /** A new SUBJECT is a fresh request to see the newest output, not a
   *  continuation of wherever the last one was scrolled to. */
  createEffect(() => {
    props.node?.id;
    props.attempt;
    setStuck(true);
  });
  createEffect(() => {
    shown();
    const node = pane;
    if (node === undefined || !stuck()) return;
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
            {/* The head names the SUBJECT — which node, which attempt, how much
                of it there is. Everything about the WINDOW moved to the foot. */}
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
              classList={{ "log-wrap": wrap() }}
              tabindex="0"
              ref={pane}
              // STICK unless the reader has scrolled away. `tail -f` and the
              // attach TUI both do this, and a pane that did not is a pane that
              // shows you the first screen of a log whose interesting end is
              // somewhere below the fold — which is every log anybody opens a
              // failure to read.
              onScroll={(event) => {
                const el = event.currentTarget;
                setStuck(
                  el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLACK,
                );
              }}
            >
              {/* A PLAIN span is a bare TEXT NODE, not a `<span>`. Almost every
                  log has no escapes at all and comes back as one span, and
                  wrapping that would put a pointless element around every log in
                  the app for the sake of the occasional coloured one. Either way
                  `innerText` reads the log's own text, which is what the
                  acceptance suite takes it from. */}
              <For each={spans()}>
                {(span) => {
                  const cls = ansiClass(span);
                  const colour = ansiColor(span);
                  return cls === "" && colour === undefined ? (
                    span.text
                  ) : (
                    <span class={cls} style={{ color: colour }}>
                      {span.text}
                    </span>
                  );
                }}
              </For>
            </pre>
            <footer class="log-foot">
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
              {/* WRAPPING IS A CHOICE, not a default. A log line is a line and
                  wrapping one changes what it says, so the pane scrolls
                  sideways — but a stack trace or a paragraph of prose on a
                  narrow screen is unreadable that way, and a person who wants it
                  wrapped wants it wrapped for the next log too. */}
              <Button
                title="wrap long lines instead of scrolling sideways"
                pressed={wrap()}
                onClick={() => {
                  const next = !wrap();
                  setWrap(next);
                  writeWrap(next);
                }}
              >
                Wrap
              </Button>
              {/* FOLLOWING, or the way back to it. The marker's hue is the LOG's
                  state — amber while it can still grow, grey once it is closed —
                  so "following" on a finished log does not read as a pane still
                  waiting for something that is never coming. */}
              <span class="log-follow">
                <Show
                  when={stuck()}
                  fallback={
                    <Button
                      title="scroll to the end and follow the output again"
                      onClick={() => {
                        setStuck(true);
                        if (pane !== undefined) {
                          pane.scrollTop = pane.scrollHeight;
                        }
                      }}
                    >
                      Jump to latest
                    </Button>
                  }
                >
                  <span
                    class={`glyph glyph-${props.tail?.open === true ? "amber" : "grey"}`}
                  >
                    ●
                  </span>
                  following
                </Show>
              </span>
            </footer>
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
  /** The nodes, grouped by the kind of machine that runs them, in the order the
   *  frame first mentions each platform — the coordinator's own order, which is
   *  stable between ticks, unlike a sort that would re-order the lanes as nodes
   *  appear under them. */
  const laneMap = createMemo(() => {
    const byPlatform = new Map<string, RunNode[]>();
    for (const node of nodes()) {
      const platform = platformOf(node.id);
      const lane = byPlatform.get(platform);
      if (lane === undefined) byPlatform.set(platform, [node]);
      else lane.push(node);
    }
    return byPlatform;
  });
  const lanes = createMemo(() => [...laneMap().keys()]);
  const laneNodes = (platform: string): RunNode[] =>
    laneMap().get(platform) ?? [];
  /** The whole-run cancel, held behind a question — see the `Confirm` below. */
  const [confirmingCancel, setConfirmingCancel] = createSignal(false);
  return (
    <section class="detail">
      {/* THE HEADER, in the order somebody reads it: what project, on what
          branch, at what commit, and how it went. The h1 used to be the commit
          ref on its own — the one thing here nobody recognises at a glance —
          while the project this run is even about appeared nowhere. */}
      <header class="detail-head">
        <Button onClick={props.onBack}>← Runs</Button>
        <h1>
          {props.run === undefined ? "run" : projectOf(props.run.repoRoot)}
          <Show when={props.run?.branch}>
            {(branch) => <span class="detail-branch">{branch()}</span>}
          </Show>
        </h1>
        {/* The ref stays, in mono, because it is the string a person PASTES.
            Empty until the row lands rather than filled with a placeholder: an
            invented ref is worse than no ref. */}
        <span class="detail-ref">
          <Show when={props.run}>
            {(run) => (
              <>
                {runRef(run().sha, run().seq)}
                <Show when={run().dirty}>
                  <span class="detail-dirty">+dirty</span>
                </Show>
              </>
            )}
          </Show>
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
        <span class="detail-scope">
          {props.run === undefined ? "" : scopeLabel(props.run.scope)}
        </span>
        <span class="detail-sub">{props.run?.repoRoot ?? ""}</span>
      </header>
      {/* The run-wide controls, and only those. `Run again` is a NEW run at the
          same commit and the same selection; `Cancel run` is this one's
          teardown. The per-lane cancels used to sit here too — a row of
          near-identical buttons whose only difference was a platform triple,
          detached from the nodes they were about. Each rides its own lane now. */}
      <div class="detail-controls">
        <Button
          title="start a NEW run of this selection, at this commit"
          disabled={busy()}
          onClick={props.controls.runAgain}
        >
          Run again
        </Button>
        <Button
          class="btn btn-danger"
          title="stop the whole run"
          disabled={busy()}
          onClick={() => setConfirmingCancel(true)}
        >
          Cancel run
        </Button>
      </div>
      {/* ARE YOU SURE — for this one control and no other. Cancelling the whole
          run throws away every lane's work at once, cannot be undone, and sits
          one button away from "Run again"; a lane's cancel and a node's are
          scoped, and the run carries on around them, so those stay one click.
          The confirmation is named for the ACT rather than for its trigger: two
          buttons both reading "Cancel run" would be ambiguous to a person and
          unaddressable to the acceptance suite. */}
      <Confirm
        open={confirmingCancel()}
        title="Cancel this run?"
        body="Every lane stops and the run is finalized as incomplete. This cannot be undone; you can start a new run afterwards."
        cancelLabel="Keep it running"
        confirmLabel="Yes, cancel it"
        danger
        onConfirm={props.controls.cancelRun}
        onClose={() => setConfirmingCancel(false)}
      />
      {/* Every control answers, including a refusal. A control that went quiet
          on a refusal is the browser's version of the failure this release
          removes. An answer that has been read can then be put away — but only
          once it IS an answer: a pending receipt carries no dismissal, because
          the thing it describes has not happened yet. */}
      <Show when={props.control.kind !== "idle"}>
        <Receipt
          role="status"
          bad={props.control.kind === "refused"}
          onDismiss={
            props.control.kind === "pending" ? undefined : props.controls.dismiss
          }
        >
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
            {/* `For` over the LANES and `Index` over the nodes inside them, and
                the difference is what each list is. A lane is addressed by its
                platform name, which is its own identity — equal strings are the
                same lane, so a lane's row survives a frame that re-sends
                everything. A `NodesFrame` IS re-sent whole on every change, so
                every node object is a new reference every tick; keying those by
                reference would rebuild every row of a running DAG several times
                a second and take the focus off whichever control a person was
                about to press. */}
            <For each={lanes()}>
              {(platform) => (
                <>
                  <LaneHead
                    platform={platform}
                    nodes={laneNodes(platform)}
                    controls={props.controls}
                    busy={busy()}
                  />
                  <Index each={laneNodes(platform)}>
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
                </>
              )}
            </For>
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
