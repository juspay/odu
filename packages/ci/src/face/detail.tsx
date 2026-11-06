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
  on,
  Show,
  type JSX,
} from "solid-js";
import { ansiSpans } from "./ansi";
import {
  isActive,
  type LaneSpan,
  laneSpan,
  pushSpan,
  runElapsedMs,
  timelineTicks,
} from "@odu/service-client/board";
import {
  BackLink,
  Button,
  Confirm,
  Hint,
  LaneStrip,
  PageHead,
  Pill,
  Receipt,
} from "@odu/face/ui";
import { bytes } from "@odu/cordis/format";
import { CommitRef } from "./commit";
import {
  duration,
  laneCells,
  lanesOf,
  NODE_STATUS,
  NODE_WORD,
  OUTCOME,
  projectOf,
  scopeLabel,
} from "./format";
import type {
  LogPage,
  LogStream,
  LogTail,
  NodePush,
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
 * the window indicator line up with the ones an `odu ci logs --offset` takes.
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

/** The statuses a lane counts, in the vocabulary's own order — so two lanes read
 *  left to right the same way whatever each of them happens to hold. */
const STATUS_ORDER = Object.keys(NODE_STATUS) as NodeStatus[];

/**
 * DID THIS NODE GO WRONG — the one reading of a node's verdict that two
 * decisions on this page depend on: the node a run opens on, and the node
 * Retry is drawn for. They are the same question asked twice, and spelled
 * twice the page could open on a failure whose own row offered no way to run
 * it again.
 */
const wentWrong = (node: RunNode): boolean =>
  node.status === "failed" || node.status === "errored";

/**
 * A PUSH SENTENCE AS A TRAILING CLAUSE, or nothing (PLAN 4.1).
 *
 * Two different sentences read the same way in this position — "not pushing —
 * no flake.nix", "pushes to kolu — its key is missing from…" — so the
 * RENDERING is shared and the CHOICE is not: each call passes the field that
 * applies to the branch it stands in. An absent one is a run that was simply
 * given no target, which the surrounding words already say.
 */
function noteSuffix(note: string | null): string {
  return note === null || note === "" ? "" : ` — ${note}`;
}

/**
 * THE PUSH STEP'S WORDS AND COLOUR — one row per state, and no colour of its
 * own.
 *
 * A push is a STEP, so it reads like one: a word for what it is doing, a
 * glyph, and a hue. All three are borrowed from the node statuses the page
 * already paints, through the status each push state IS the analogue of — a
 * push in flight is `running`, one that landed is `ok`, one that did not is
 * `failed`. Borrowing rather than minting is the rule {@link NODE_STATUS}'s
 * own doc sets: colour on this page means one thing, assigned once, and a
 * fourth palette for a second kind of work is how a reader learns that amber
 * means two different things depending on which row it is on.
 *
 * The NODE's status is untouched by any of this. It reads the RECIPE's
 * verdict throughout — a failed push turns the node red through the lane, not
 * through this table, which is why `failed` here says "push failed" rather
 * than "failed": the row already carries one verdict and this is a second
 * fact about a different step.
 */
const PUSH_META: Record<NodePush["state"], { word: string; as: NodeStatus }> = {
  pushing: { word: "pushing", as: "running" },
  pushed: { word: "pushed", as: "ok" },
  failed: { word: "push failed", as: "failed" },
};

/** WHAT THE PUSH STEP SAYS, after its state — the counts a landed push has and
 *  the duration every settled one does. A push still in flight has neither: it
 *  has sent nothing it can count yet, and `0 paths` on it would be a claim
 *  about the bucket that nobody has made. Its length is the hatched bar
 *  instead, which is the honest picture of "still going". */
function pushFacts(push: NodePush): string {
  switch (push.state) {
    case "pushing":
      return "";
    case "pushed":
      return ` · ${push.paths} path${push.paths === 1 ? "" : "s"} · ${bytes(push.bytes)} · ${duration(push.durationMs)}`;
    case "failed":
      return ` · ${duration(push.durationMs)}`;
  }
}

/**
 * WHICH NODE A RUN OPENS ON when its address names none.
 *
 * A run page whose log pane is empty has asked the one question the page
 * exists to answer — "what went wrong" — and then made the reader answer it:
 * the failure is already drawn, red, in the list beside the blank pane. So the
 * page opens on the evidence, in the order a person would click:
 *
 *   - the FIRST node that went wrong, because that is what a red run is about
 *     and the first one is the one the others may be consequences of;
 *   - else the one that is RUNNING, which is where a live run's output is;
 *   - else the LAST node with an attempt, which is where a green run ended.
 *
 * Nodes with no attempt are skipped throughout: they have no log to read, and
 * their row's button is disabled for the same reason.
 *
 * It is a CHOICE OF ADDRESS and not a selection kept beside one — `ci.tsx`
 * turns this into the log key the panel subscribes by, so the pane and the
 * `#/run/<id>` a person pasted still describe the same thing and a click on
 * another node still moves the address as it always did.
 */
export function openingNode(nodes: readonly RunNode[]): RunNode | null {
  const readable = nodes.filter((node) => node.attempt > 0);
  const wrong = readable.find(wentWrong);
  if (wrong !== undefined) return wrong;
  const running = readable.find((node) => node.status === "running");
  if (running !== undefined) return running;
  return readable[readable.length - 1] ?? null;
}

/**
 * A LANE'S HEADER — one platform's worth of the DAG, named, counted and
 * DRAWN.
 *
 * A run's nodes arrive as one flat list whose only clue about which machine a
 * row belongs to is the `@platform` suffix at the end of an id that is already
 * too long to scan. Grouping them puts the four facts a person wants about a
 * lane — which platform, which machine, how far along, and the shape of that
 * progress — in one row above the work, and puts the button that drops the
 * lane ON the lane rather than in a bar of near-identical buttons at the top
 * of the page.
 *
 * The strip is the SAME component the board draws in its pipeline column, fed
 * from the same reading: the eleven pixels a person recognised on the board
 * are the eleven pixels they find here, in the same order, when they open the
 * run to see which of them went red.
 */
function LaneHead(props: {
  platform: string;
  nodes: readonly RunNode[];
  controls: DetailControls;
  busy: boolean;
  canRun: boolean;
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
  /** Is there anything in this lane left to stop? A lane whose every node has
   *  settled cannot be cancelled — the verb would be refused, and a control
   *  that can only be refused is a control that lies about what the page can
   *  do. */
  const unfinished = (): boolean =>
    props.nodes.some(
      (node) => node.status === "running" || node.status === "pending",
    );
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
          hue together are still not a sentence.

          The NATIVE `title` here, deliberately, where every control on the page
          gets a drawn `.tip`: these spans are not controls. They are not
          focusable, so the half of a drawn tooltip that earns its keep — the
          keyboard user who never sees a native one — has nobody to serve, and
          five tooltips down a lane header would be five boxes chasing a
          pointer across a row of digits. */}
      <span class="lane-counts">
        <For each={counts()}>
          {(entry) => (
            <span title={`${entry.count} ${NODE_WORD[entry.status]}`}>
              <span class={`glyph hue-${NODE_STATUS[entry.status].hue}`}>
                {NODE_STATUS[entry.status].glyph}
              </span>
              {entry.count}
            </span>
          )}
        </For>
      </span>
      {/* THE LANE, AS CELLS — no label, because the platform is already the
          first thing on this line and a strip that repeated it would be the
          one piece of furniture in a row of facts. */}
      <LaneStrip cells={laneCells(props.nodes)} />
      {/* A lane with no platform has no lane to cancel: `run.cancel` addresses a
          lane BY platform, so the button here would name nothing — and a lane
          that has already stopped has nothing left to drop. */}
      <Show when={props.canRun && props.platform !== "" && unfinished()}>
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
  /** WHERE this node sat in its run, from the shared geometry — or `null` for a
   *  node that has not started, which draws no bar at all. Computed by the
   *  caller, which is the one place the run and the clock both are. */
  span: LaneSpan | null;
  /** WHERE ITS PUSH SAT, from the same geometry and on the same scale — the
   *  segment that begins where the recipe's bar ends. `null` on a node with no
   *  push step, which is most of them. Computed by the caller for the same
   *  reason the recipe's is: the run and the clock are both up there. */
  push: LaneSpan | null;
  /** WHERE THIS RUN PUSHES. The run's own `push.target.bucket`, because every
   *  node of a run sends to the same bucket or to none — the node carries what
   *  its push DID, never where it went, and a second copy of the destination
   *  per row would be a thing to keep true. `null` while the row has not
   *  arrived, which the step spells rather than inventing a name. */
  bucket: string | null;
  selected: string | null;
  onSelect: (node: RunNode) => void;
  controls: DetailControls;
  busy: boolean;
  canRun: boolean;
}): JSX.Element {
  const meta = (): (typeof NODE_STATUS)[RunNode["status"]] =>
    NODE_STATUS[props.node.status];
  /**
   * THE PUSH STEP, ASSEMBLED ONCE — its sentence, its colour and its geometry
   * in one object, or `null` on a node that has no push at all.
   *
   * One accessor because the row draws this step in TWO places: the line
   * under the button, and the segment inside the track. Two independent
   * `<Show>`s over two different props — the node's `push` and the caller's
   * span — could disagree about whether there is a step here at all, which is
   * a bar with no label or a label with no bar. There is one question, so it
   * is asked once and both drawings hang off the answer.
   */
  const step = createMemo(() => {
    const push = props.node.push;
    if (push === undefined) return null;
    const vocab = PUSH_META[push.state];
    const status = NODE_STATUS[vocab.as];
    return {
      // The state word LEADS, and every one of them begins with "push" —
      // `pushing`, `pushed`, `push failed` — so the step names itself without
      // a separate label repeating the word three characters later.
      //
      // The destination is the RUN's bucket, and when the row carrying it has
      // not arrived the step says the state alone rather than inventing a
      // noun for where the bytes went. That is also the fence: this face
      // spells no word of the row that serves buckets — the name it draws is
      // a prop the shell filled, like the link under it.
      text: `${vocab.word}${props.bucket === null ? "" : ` → ${props.bucket}`}${pushFacts(push)}`,
      hue: status.hue,
      glyph: status.glyph,
      span: props.push,
    };
  });
  /** Why this row can be opened, or why it cannot. Said once and drawn twice:
   *  as the native `title` and as the `.tip` beside it. */
  const hint = (): string =>
    props.node.attempt === 0
      ? "this node has not started, so it has no output yet"
      : `read ${props.node.id}, attempt ${props.node.attempt}`;
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
        title={hint()}
      >
        <span class={`glyph hue-${meta().hue}`}>{meta().glyph}</span>
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
        {/* The drawn half of the `title` above. This control is hand-spelled
            rather than built from `Button` — it is a row of labelled cells —
            and without this it was one of two places on the page still falling
            back to the browser's own tooltip, which a keyboard user never sees
            at all. The `.tip` is `display: none` until hovered, so the flex
            line does not move. */}
        <Hint text={hint()} />
      </button>
      {/* ONLY WHERE THEY APPLY. These two used to be on every row and disabled on
          most of them. A disabled button that can never be pressed is noise, and
          a control's absence is the honest statement that the action does not
          apply: Retry needs an attempt that WENT WRONG; Cancel node needs
          something running to stop.

          Retry on a node that PASSED is the one that reads as a control and is
          not: re-running work whose verdict is already green answers no
          question a person opened this page with, and it sat on every row of a
          finished run. The way to run green work again is Run again, which is
          what that control says. */}
      <Show when={props.canRun}>
      <span class="node-controls">
        <Show when={props.node.attempt > 0 && wentWrong(props.node)}>
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
      </Show>
      {/* THE PUSH, AS ITS OWN STEP — a line of its own under the node, because
          it is a second piece of work with a second verdict and it used to be
          a trailing cell on the node's own button. As a cell it could only
          ever say what had ALREADY happened: a push in flight had nothing to
          append, so the minute a lane spends sending a closure looked exactly
          like a node that pushed nothing at all, and a push that FAILED
          appeared as a missing cell beside a red node whose recipe was green.

          Its own line rather than a second list row: the push belongs TO this
          node — it is the same attempt's second half, addressed by the same
          log key — and a sibling `li` would have made the node list disagree
          with the node count above it.

          `role="group"` with the node's own name, so the step is addressable
          and announced as one thing rather than three loose spans. The name
          carries the node id because a run has one of these per node and two
          controls sharing an accessible name are ambiguous to a person and
          unaddressable to anything that finds an element by what it says. */}
      <Show when={step()}>
        {(push) => (
          <span
            class="node-push-step"
            role="group"
            aria-label={`Push ${props.node.id}`}
          >
            <span class={`glyph hue-${push().hue}`}>{push().glyph}</span>
            {push().text}
          </span>
        )}
      </Show>
      {/* THE TIMELINE — where this node's latest attempt ran inside the run,
          not merely how long it took, so parallel work reads as parallel and
          the critical path is the bar nothing overlaps.

          A CHILD OF THE ROW, not of the button. The button is `flex: 1` beside
          a controls cell that is empty on a pending row, one button wide on a
          settled one and another width again on a running one — so a track
          inside it was a different box on every row, and `left: 50%` meant
          three different instants down one list. The row's own box does not
          vary, and neither does the axis's, so one scale is drawn once.

          A bar is skipped only where the span begins AT the track's end: that
          is the clamp's answer for a lane whose start outran the run, and it
          has nowhere to be drawn. A zero-WIDTH span is not the same thing — a
          node that genuinely took no measurable time has `durationMs: 0`, which
          is the exact case `min-width` on the bar exists for.

          The hue comes from the SAME `hue-*` class the glyph wears, and the
          hatch from the SAME arm the geometry took (`kind`), so neither can
          disagree with what the node is doing. */}
      <span class="node-track">
        <Show when={props.span}>
          {(span) => (
            <Show when={span().left < 1}>
              <span
                class={`node-bar hue-${meta().hue}`}
                classList={{ "node-bar-running": span().kind === "running" }}
                style={{
                  left: `${span().left * 100}%`,
                  width: `${span().width * 100}%`,
                }}
              />
            </Show>
          )}
        </Show>
        {/* THE PUSH SEGMENT, IN THE SAME TRACK. Not a track of its own: the
            axis above this list is drawn in one box and `packages/ci/e2e`'s
            timeline scenario asserts every node's track is THAT box, so a
            second rail under the row would be a bar measured against a scale
            nothing labels. It is also the truth of the thing — the push
            happens inside the same run, on the same clock, immediately after
            the recipe whose bar it continues.

            Its hue is the PUSH's, not the node's, which is the one place on
            this row the two can differ: a red segment under a green bar is a
            node whose recipe passed and whose closure did not land, and that
            difference is the whole reason this step exists. The hatch follows
            the same `kind` the recipe's does, so a push still sending reads as
            provisional in the same vocabulary. */}
        <Show when={step()}>
          {(push) => (
            <Show when={push().span}>
              {(span) => (
                <Show when={span().left < 1}>
                  <span
                    class={`node-bar node-push-bar hue-${push().hue}`}
                    classList={{
                      "node-bar-running": span().kind === "running",
                    }}
                    style={{
                      left: `${span().left * 100}%`,
                      width: `${span().width * 100}%`,
                    }}
                  />
                </Show>
              )}
            </Show>
          )}
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
 * Four questions the raw tail cannot answer, and one control each:
 *
 *   - **Which attempt.** `RunNode.attempt` is the HIGHEST attempt recorded, and
 *     a retried node's earlier attempt holds the evidence of the failure that
 *     caused the retry — the thing a person came to read. It was reachable only
 *     by hand-editing the URL, which is not a control.
 *   - **Which STREAM.** A node that pushes has two logs on one key: what the
 *     recipe printed, and what the push client said while it sent the closure.
 *     The second one is where a failed push explains itself, and without a
 *     control for it the only evidence of a red node whose recipe exited 0
 *     was unreachable from the page that drew it red.
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
export function LogPanel(props: {
  node: RunNode | null;
  attempt: number | null;
  onAttempt: (attempt: number) => void;
  /** WHICH of the node's two logs is on screen. OWNED UPSTREAM, beside the log
   *  key, because it is one half of what the two `log.read` call sites ask
   *  for — a copy here would be a second answer to "which log am I reading"
   *  and the pane would show one while the wire fetched the other. */
  stream: LogStream;
  onStream: (stream: LogStream) => void;
  tail: LogTail | undefined;
  /** The cursored follow's accumulated text — byte-exact, unlike the bounded
   *  tail beside it. Null before the first page arrives. */
  followed: string | null;
  /** Why this log could not be read — a refused page, or a follow that gave up.
   *  Shown beside the log rather than swallowed, because a pane that has quietly
   *  stopped updating looks exactly like a log that has quietly stopped
   *  growing. */
  logFault: string | null;
  pending: boolean;
  error: Error | undefined;
  onPage: (offset: number) => void;
  page: LogPage | null;
}): JSX.Element {
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
  //
  // AND THE TAIL IS THE RECIPE'S, which is why the push stream stops one step
  // short of it. `collections.logTails` is keyed by the log key alone and
  // carries the recipe's bytes; falling back to it on the Push tab would put
  // the recipe's output under a heading that says Push — the one failure mode
  // worse than an empty pane, because it looks like an answer. There is
  // nothing to lose by stopping: the push stream's follow opens with a
  // `-LOG_TAIL_BYTES` read, so its first page IS a tail and lands in the same
  // breath.
  const shown = createMemo(() => {
    const paged = props.page?.text;
    if (paged !== undefined) return paged;
    const following = props.logFault === null ? props.followed : null;
    if (props.stream === "push") return following ?? "";
    return following ?? props.tail?.text ?? "";
  });

  /** IS THE STREAM ON SCREEN STILL BEING WRITTEN — the fact the footer's
   *  "following" marker is about, asked of whichever log is shown. The tail's
   *  `open` answers it for the recipe; for the push it is the push's own
   *  state, because the tail collection does not cover that file and a marker
   *  driven by the recipe's would announce a finished push as live (or a live
   *  one as finished) on a node whose recipe had stopped. */
  const growing = createMemo(() =>
    props.stream === "push"
      ? props.node?.push?.state === "pushing"
      : props.tail?.open === true,
  );

  /** The text as the recipe COLOURED it. Memoised on `shown()`, so a re-render
   *  that changes nothing else does not re-scan the page.
   *
   *  What is drawn and what is deliberately thrown away — cursor motion,
   *  backgrounds, and a bare `\r` approximated as "start this line over", which
   *  discards whatever preceded it on that line — is all in `./ansi`'s header.
   *  This view only draws what that module returns. */
  const spans = createMemo(() => ansiSpans(shown()));

  /** A new SUBJECT is a fresh request to see the newest output, not a
   *  continuation of wherever the last one was scrolled to. The STREAM is one
   *  of the three things that make it a new subject: switching to the push
   *  log is asking to read a different file, and inheriting the scroll
   *  position of the recipe's would land a reader in the middle of it. The
   *  dependencies are SAID, with Solid's own explicit form, rather than left
   *  to bare expression statements that read as dead code to a reader, to a
   *  linter and to anything that strips no-ops. */
  createEffect(
    on(
      [() => props.node?.id, () => props.attempt, () => props.stream],
      () => setStuck(true),
    ),
  );
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
      {/* A PHRASE, not a paragraph, for the fallback below. The page opens on a
          node by itself — see {@link openingNode} — so an empty pane is reached
          only by a run with no readable work in it yet, where two sentences
          about how attempts keep their logs are two sentences about nothing on
          screen. */}
      <Show
        when={props.node}
        fallback={<p class="empty">select a node</p>}
      >
        {(node) => (
          <div class="log-body">
            {/* The head names the SUBJECT — which node, which attempt, how much
                of it there is. Everything about the WINDOW moved to the foot. */}
            <header class="log-head">
              <h3>{node().id}</h3>
              {/* RECIPE | PUSH, and only on a node that HAS a push: one log
                  is not a choice, and a group of one button announcing itself
                  as a group is noise a screen reader has to read.

                  The attempt picker's idiom exactly — a `role="group"` with a
                  name, holding `Button`s whose `pressed` is their selection —
                  because that is what these are: two buttons, one of which is
                  currently chosen. `@odu/face/ui` has no tab primitive, and a
                  pair of buttons is not reason enough to grow one; a real
                  `tablist` would also owe this page roving focus, arrow-key
                  movement and `tabpanel` wiring for a control a reader
                  presses once.

                  "Log" rather than "Stream": the name is read out before the
                  button a person is about to press, and `Log: Recipe` is what
                  this is. It does not collide with anything else on the page —
                  the pane beside it is `Node output`. */}
              <Show when={node().push !== undefined}>
                <span class="log-streams" role="group" aria-label="Log">
                  <Button
                    title="what the recipe printed"
                    pressed={props.stream === "recipe"}
                    onClick={() => props.onStream("recipe")}
                  >
                    Recipe
                  </Button>
                  <Button
                    title="what the push client said while it sent this node's closure"
                    pressed={props.stream === "push"}
                    onClick={() => props.onStream("push")}
                  >
                    Push
                  </Button>
                </span>
              </Show>
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
                    that died mid-sentence.

                    Both of them are the RECIPE's — `collections.logTails`
                    covers that file and no other — so the push stream says
                    what it is instead of borrowing a number about a different
                    log, and adds the window's own size once a page has been
                    asked for. A wrong byte count is worse than none: it is the
                    number a reader checks a truncated log against. */}
                {props.stream === "push"
                  ? `push log${props.page === null ? "" : ` · ${bytes(props.page.size)}`}`
                  : props.tail === undefined
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
            <Show when={props.logFault}>
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
              {/* `Index`, not `For`. The span list is re-minted WHOLE on every
                  append — `ansiSpans` returns brand-new objects each tick — so
                  keying by reference, which is what `For` does, would tear down
                  and rebuild the whole pane several times a second while a run
                  is live, taking a reader's selection with it. That is the same
                  rule the node list and the board keep, and this is the one
                  surface somebody is actively reading while it moves.
                  `innerText` still reads the log's own text, which is what the
                  acceptance suite takes it from. */}
              <Index each={spans()}>
                {(span) => (
                  <span class={span().class} style={{ color: span().color }}>
                    {span().text}
                  </span>
                )}
              </Index>
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
                disabled={(props.page?.offset ?? 0) <= 0}
                onClick={() =>
                  props.onPage(
                    Math.max(0, (props.page?.offset ?? 0) - LOG_PAGE_BYTES),
                  )
                }
              >
                Older
              </Button>
              <Button
                title="the page after this one"
                // `eof` is the verb's own word for "this page reached the end",
                // rather than an offset comparison this view would have to keep
                // true against a log that is still growing.
                disabled={props.page === null || props.page.eof}
                onClick={() => props.onPage(props.page?.nextOffset ?? 0)}
              >
                Newer
              </Button>
              {/* WHERE the shown window is, in the same byte offsets the verb
                  takes. Without it "Older" and "Newer" are two buttons that
                  change the text and say nothing about what changed — and a
                  person paging through a long log has no way to tell a step that
                  worked from one that hit an end. */}
              <Show when={props.page}>
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
              {/* FOLLOWING, or the way back to it — and the marker is drawn
                  only while the LOG ON SCREEN is still open. A finished
                  attempt's log cannot grow, so "following" on one is a pane
                  announcing it is waiting for something that is never coming;
                  see {@link growing} for why the push stream answers that
                  from its own state rather than from the recipe's tail.
                  "Jump to latest" stays either way: scrolling back to the end
                  of a log is worth a control whether or not the end is still
                  moving. */}
              <span class="log-follow">
                <Show
                  when={stuck()}
                  fallback={
                    <Button
                      title="scroll to the end and follow the output again"
                      // The FLAG, and nothing else: the effect above owns the
                      // scroll and already tracks `stuck`, so it performs this
                      // one on the next microtask exactly as it does for an
                      // incoming append. Touching the pane here as well was a
                      // second implementation of one behaviour, running one
                      // tick earlier than the one that owns it.
                      onClick={() => setStuck(true)}
                    >
                      Jump to latest
                    </Button>
                  }
                >
                  <Show when={growing()}>
                    <span class="glyph hue-amber">●</span>
                    following
                  </Show>
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
  /** WHERE A BUCKET'S PAGE IS, from the shell (PLAN 4.1). A route is the
   *  SHELL's vocabulary — `packages/web-ui/src/app.tsx` is the one speller of
   *  `#/cache/<bucket>` — and a face that wrote one itself would be a second
   *  place a cross-row address could drift. */
  bucketHref: (bucket: string) => string;
  /** The page's own ticking clock — the SAME one the board's ages read, so a
   *  live run's timeline grows on one interval rather than this view's second
   *  idea of now. The run row carries the origin; the clock carries the end. */
  now: number;
  pending: boolean;
  error: Error | undefined;
  selected: RunNode | null;
  onSelect: (node: RunNode | null) => void;
  /** MAY THIS PERSON CHANGE THIS RUN? The runs' floor is `member`, so every
   *  principal that can see a run at all holds it today — the shell passes it
   *  anyway, because the RULE is the row's and PR 4 is where an org narrows it.
   *  False hides Run again / Cancel run / Retry / Cancel node and nothing else:
   *  the evidence stays readable. */
  canRun: boolean;
  /** THE LOG PANE, handed over built. Nine props used to arrive here — the
   *  attempt, the tail, the follow, the page and their handlers — and `Detail`
   *  read none of them: each was declared, documented and forwarded verbatim to
   *  {@link LogPanel}, so what a log pane needs was spelled three times and a
   *  change to it was a three-file edit through a component with no opinion
   *  about logs. It is built in `app.tsx`, where the wire already is.
   *
   *  Safe against the `<Show>`-disposal hazard `@odu/face`'s `ui.tsx` header
   *  documents: this sits in `.detail-body` with no `<Show>` or `<Match>`
   *  above it inside `Detail`, and the whole `Detail` element is re-minted on
   *  route re-entry because a `<Match>`'s children compile to a getter. */
  log: JSX.Element;
  control: ControlState;
  controls: DetailControls;
  onBack: () => void;
}): JSX.Element {
  const busy = createMemo(() => props.control.kind === "pending");
  /** IS THERE STILL A RUN TO STOP? `isActive` is the board's own reading —
   *  provisioning or running — so the page and the row cannot disagree about
   *  whether this run is live, which is what decides every cancel on it. A run
   *  the page has not read yet is not assumed live: a cancel that appears and
   *  then vanishes is worse than one that arrives a tick late. */
  const live = createMemo(
    () => props.run !== undefined && isActive(props.run),
  );
  const nodes = createMemo<RunNode[]>(() => [...(props.frame?.nodes ?? [])]);
  /** The nodes, grouped by the kind of machine that runs them, in the order
   *  the frame first mentions each platform — the coordinator's own order,
   *  which is stable between ticks, unlike a sort that would re-order the
   *  lanes as nodes appear under them. The grouping itself is `./format`'s,
   *  because the board's pipeline column performs the same one and two
   *  spellings of "which lane is this node in" is how a board and a run come
   *  to draw a different number of lanes for one piece of work. */
  const laneMap = createMemo(
    () => new Map(lanesOf(nodes()).map((lane) => [lane.platform, lane.nodes])),
  );
  const lanes = createMemo(() => [...laneMap().keys()]);
  const laneNodes = (platform: string): readonly RunNode[] =>
    laneMap().get(platform) ?? [];
  /** WHERE THIS RUN'S PUSHES GO, or `null` for a run that pushes nowhere —
   *  read off the RUN, because every node of a run sends to the same bucket
   *  or to none, and the node carries what its push did rather than where it
   *  went. The node rows take it from here so the destination is spelled in
   *  one place on this page. */
  const bucket = createMemo<string | null>(
    () => props.run?.push?.target?.bucket ?? null,
  );
  /**
   * WHAT THIS RUN WARMED, SUMMED — the header's own total, folded from the
   * nodes the page is already holding.
   *
   * CLIENT-SIDE on purpose. `AttentionAnswer` carries a run-wide `paths` /
   * `bytes` pair, but this view is drawn from `streams.nodes`, which is the
   * frame that actually ticks while a run is live — a total read off a second
   * source would lag the rows under it by a tick and a reader would see a
   * header that disagreed with the sum of the list beneath it.
   *
   * ONLY LANDED PUSHES COUNT. A push in flight has sent nothing it can claim,
   * and a failed one sent nothing at all; both would otherwise inflate a
   * number people read as "what the next machine will not have to build". The
   * failures are carried BESIDE the total rather than folded into it, because
   * "3 paths landed and one node's push failed" is two facts and a reader
   * needs both.
   *
   * `null` is a run that pushed nothing and failed at nothing — most runs,
   * and the header stays quiet rather than printing a row of zeroes.
   */
  const pushed = createMemo(() => {
    let paths = 0;
    let narBytes = 0;
    let landed = 0;
    const failedOn: string[] = [];
    for (const node of nodes()) {
      const push = node.push;
      if (push === undefined) continue;
      if (push.state === "pushed") {
        landed += 1;
        paths += push.paths;
        narBytes += push.bytes;
      } else if (push.state === "failed") {
        failedOn.push(node.id);
      }
    }
    return landed === 0 && failedOn.length === 0
      ? null
      : { paths, bytes: narBytes, failedOn };
  });
  /** The whole-run cancel, held behind a question — see the `Confirm` below. */
  const [confirmingCancel, setConfirmingCancel] = createSignal(false);
  return (
    <section class="screen detail">
      {/* THE WAY BACK. The rail beside this page lists the ROWS — Runs,
          Cache, Machines — and one run is not a row: it is a page inside the
          runs, so it keeps its own way out. "All runs" rather than "Runs"
          because the rail already offers a control by that name, and two
          buttons sharing one accessible name are ambiguous to a person and
          unaddressable to anything that finds a control by what it says. */}
      <BackLink onClick={props.onBack}>All runs</BackLink>
      {/* THE HEADER, in the order somebody reads it: what project, on what
          branch, how it went — and under that, in mono, the four strings a
          person compares or pastes. The h1 used to be the commit ref on its
          own — the one thing here nobody recognises at a glance — while the
          project this run is even about appeared nowhere.

          It is a `PageHead` like every other screen's, carrying `detail-head`
          as well: that is the class the outcome pill is addressed through,
          and a run's header being "the page head, plus a verdict" is exactly
          what it is. */}
      <PageHead
        class="detail-head"
        title={
          <>
            {props.run === undefined ? "run" : projectOf(props.run.repoRoot)}
            <Show when={props.run?.branch}>
              {(branch) => <span class="branch">{`/ ${branch()}`}</span>}
            </Show>{" "}
            {/* THE VERDICT, beside the name and not off at the far edge of
                the page: "did it pass" is read in the same glance as "what is
                it", and an outcome parked with the controls reads as another
                control. Absent until there IS one — a run that has not
                finished has no verdict, and a grey "no outcome yet" pill
                would be a verdict about that. */}
            <Show when={props.run?.outcome}>
              {(outcome) => (
                <Pill hue={OUTCOME[outcome()].hue}>{OUTCOME[outcome()].label}</Pill>
              )}
            </Show>
          </>
        }
        sub={
          <>
            {/* The ref, in mono, because it is the string a person PASTES.
                Empty until the row lands rather than filled with a
                placeholder: an invented ref is worse than no ref. */}
            <span class="detail-ref">
              <Show when={props.run}>
                {(run) => (
                  <CommitRef sha={run().sha} seq={run().seq} dirty={run().dirty} />
                )}
              </Show>
            </span>
            <span class="detail-scope">
              {props.run === undefined ? "" : scopeLabel(props.run.scope)}
            </span>
            {/* HOW LONG IT TOOK, from the one elapsed rule the board's own
                `Took` column uses, so the two cannot disagree by a tick. */}
            <span class="detail-sub">
              {props.run === undefined
                ? ""
                : duration(runElapsedMs(props.run, props.now))}
            </span>
            <Show when={props.run?.parentRunId}>
              {(parent) => (
                <span class="detail-parent">{`replay of ${parent()}`}</span>
              )}
            </Show>
            {/* WHO STARTED IT (PLAN 4.4). Beside the lineage and the
                checkout, because it is the same kind of fact: provenance a
                reader needs when the run is not theirs. Absent for a run
                recorded before odu asked, and nothing is drawn then — an
                invented "started by local" would be a claim about history. */}
            <Show when={props.run?.actor}>
              {(actor) => (
                <span class="detail-actor">{`started by ${actor()}`}</span>
              )}
            </Show>
            <span class="detail-sub">{props.run?.repoRoot ?? ""}</span>
            {/* WHERE THIS RUN'S BUILDS GO (PLAN 4.1) — the bucket, linked to
                its own page, or the one sentence saying why nothing is being
                pushed. On the HEADER rather than beside a node, because a push
                target is a property of the run: every node sends to the same
                bucket, or to none. */}
            <Show when={props.run?.push}>
              {(push) => (
                <span class="detail-push">
                  <Show
                    when={push().target}
                    fallback={<>{`not pushing${noteSuffix(push().skipped)}`}</>}
                  >
                    {(target) => (
                      <>
                        {"pushes to "}
                        <a class="link" href={props.bucketHref(target().bucket)}>
                          {target().bucket}
                        </a>
                        {noteSuffix(push().keyWarning)}
                      </>
                    )}
                  </Show>
                </span>
              )}
            </Show>
            {/* AND WHAT ACTUALLY LANDED. The line above says where this run
                pushes; this one says whether anything got there, which is the
                difference between "configured to warm the cache" and "the
                cache is warm". Beside the target rather than under each node
                because it is a fact about the RUN — the per-node detail is on
                the node's own push step.

                The failures ride here too, named. A run can be green by every
                recipe's verdict and still have left a closure behind, and
                "pushed 40 paths" on its own would be the sentence that hides
                it. */}
            <Show when={pushed()}>
              {(total) => (
                <span class="detail-push-total">
                  {`pushed ${total().paths} path${total().paths === 1 ? "" : "s"} · ${bytes(total().bytes)}`}
                  <Show when={total().failedOn.length > 0}>
                    <span class="detail-push-failed">
                      {` · push failed on ${total().failedOn.join(", ")}`}
                    </span>
                  </Show>
                </span>
              )}
            </Show>
          </>
        }
        actions={
          /* The run-wide controls, and only those. `Run again` is a NEW run at
             the same commit and the same selection; `Cancel run` is this
             one's teardown — and it is drawn only while there IS a run to tear
             down. A finished run's cancel can do nothing but be refused, and it
             sat beside Run again on every settled page, which is the one place
             a mis-click costs most. The per-lane cancels used to sit here too —
             a row of near-identical buttons whose only difference was a
             platform triple, detached from the nodes they were about. Each
             rides its own lane now, and a node's retry rides its node. */
          <Show when={props.canRun}>
            <div class="detail-controls">
              <Button
                title="start a NEW run of this selection, at this commit"
                disabled={busy()}
                onClick={props.controls.runAgain}
              >
                Run again
              </Button>
              <Show when={live()}>
                <Button
                  class="btn-danger"
                  title="stop the whole run"
                  disabled={busy()}
                  onClick={() => setConfirmingCancel(true)}
                >
                  Cancel run
                </Button>
              </Show>
            </div>
          </Show>
        }
      />
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
          the thing it describes has not happened yet.

          ONE `<p>`, whose tone flips pending → answer in place, so the `role`
          changes on a live element. That is the cheap spelling and it is what
          the page has always done; if a screen-reader pass finds an `alert`
          added to an existing node goes unannounced, key this `<Show>` on
          `props.control.kind` so a fresh element is minted per answer. */}
      <Show when={props.control.kind !== "idle"}>
        <Receipt
          tone={props.control.kind === "refused" ? "refused" : "ok"}
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
            {/* THE AXIS the bars below are read against — once per list, not
                once per row, and only where there is a run to measure AND work
                to measure it against: a provisioning run says "no work yet" in
                a sentence above, and an axis alone in the card would be four
                tick labels in a box that `.node-list:empty` exists to hide.

                Ticks come from the same module the bars do, asked with the same
                run and clock — a hand-rolled scale here would be a second
                answer to where the middle of a run is. */}
            <Show when={nodes().length > 0 ? props.run : undefined}>
              {(run) => (
                <li class="node-axis" aria-hidden="true">
                  <span class="node-axis-track">
                    {/* `Index`, like the node rows below and for the same
                        reason: these objects are minted afresh every second, so
                        keying by reference would rebuild four spans a second
                        for a scale whose POSITIONS never move. */}
                    <Index each={timelineTicks(run(), props.now)}>
                      {(tick) => (
                        <span
                          class="node-axis-tick"
                          style={{ left: `${tick().at * 100}%` }}
                        >
                          {/* This page's own spelling of a duration, the one
                              its node rows already print — the axis carries a
                              position and a number, never a string. */}
                          {duration(tick().ms)}
                        </span>
                      )}
                    </Index>
                  </span>
                </li>
              )}
            </Show>
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
                    canRun={props.canRun}
                  />
                  <Index each={laneNodes(platform)}>
                    {(node) => (
                      <NodeRow
                        node={node()}
                        // No run row, no origin to measure from — and an
                        // invented one would place every bar wrongly rather
                        // than not at all.
                        span={
                          props.run === undefined
                            ? null
                            : laneSpan(node(), props.run, props.now)
                        }
                        // The push's segment, on the same scale and from the
                        // same module — `null` on a node with no push, which
                        // is what draws no second segment at all.
                        push={
                          props.run === undefined
                            ? null
                            : pushSpan(node(), props.run, props.now)
                        }
                        bucket={bucket()}
                        selected={props.selected?.id ?? null}
                        onSelect={props.onSelect}
                        controls={props.controls}
                        busy={busy()}
                        canRun={props.canRun}
                      />
                    )}
                  </Index>
                </>
              )}
            </For>
          </ul>
        </section>
        {props.log}
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
