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
  pushTotals,
  runElapsedMs,
  timelineTicks,
} from "@odu/service-client/board";
import {
  BackLink,
  Button,
  Confirm,
  LaneStrip,
  PageHead,
  Pill,
  Receipt,
  TitleTooltip,
} from "@odu/face/ui";
import { bytes } from "@odu/cordis/format";
import { STATUS_META } from "@odu/service-client/surface";
import { CommitRef } from "./commit";
import {
  duration,
  type FollowedPage,
  laneCells,
  lanesOf,
  logMetaText,
  NODE_WORD,
  OUTCOME,
  projectOf,
  pushCounts,
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

export const LOG_PAGE_BYTES = 64 * 1024;

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
  dismiss: () => void;
}

const STATUS_RANK: Record<NodeStatus, number> = {
  pending: 0,
  running: 1,
  ok: 2,
  failed: 3,
  skipped: 4,
  errored: 5,
  cancelled: 6,
};

const STATUS_ORDER: readonly NodeStatus[] = (
  Object.keys(STATUS_RANK) as NodeStatus[]
).sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b]);

const wentWrong = (node: RunNode): boolean =>
  node.status === "failed" || node.status === "errored";

function noteSuffix(note: string | null): string {
  return note === null || note === "" ? "" : ` — ${note}`;
}

function pushStep(
  push: NodePush,
  bucket: string | null,
): { text: string; as: NodeStatus } {
  const to = bucket === null ? "" : ` → ${bucket}`;
  switch (push.state) {
    case "pushing":
      return { text: `pushing${to}`, as: "running" };
    case "pushed":
      return {
        text: `pushed${to} · ${pushCounts(push)} · ${duration(push.durationMs)}`,
        as: "ok",
      };
    case "failed":
      return {
        text: `push failed${to} · ${duration(push.durationMs)}`,
        as: "failed",
      };
  }
}

export function openingNode(nodes: readonly RunNode[]): RunNode | null {
  const readable = nodes.filter((node) => node.attempt > 0);
  const wrong = readable.find(wentWrong);
  if (wrong !== undefined) return wrong;
  const running = readable.find((node) => node.status === "running");
  if (running !== undefined) return running;
  return readable[readable.length - 1] ?? null;
}

function LaneHead(props: {
  platform: string;
  nodes: readonly RunNode[];
  controls: DetailControls;
  busy: boolean;
  canRun: boolean;
}): JSX.Element {
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
  const unfinished = (): boolean =>
    props.nodes.some(
      (node) => node.status === "running" || node.status === "pending",
    );
  return (
    <li class="lane">
      <span class="lane-platform">
        {props.platform === "" ? "(no platform)" : props.platform}
      </span>
      <span class="lane-host">
        {hosts().length === 0 ? "claiming a machine" : hosts().join(", ")}
      </span>
      <span class="lane-counts">
        <For each={counts()}>
          {(entry) => (
            <span title={`${entry.count} ${NODE_WORD[entry.status]}`}>
              <span class={`glyph hue-${STATUS_META[entry.status].hue}`}>
                {STATUS_META[entry.status].glyph}
              </span>
              {entry.count}
            </span>
          )}
        </For>
      </span>
      <LaneStrip cells={laneCells(props.nodes)} />
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
  span: LaneSpan | null;
  push: LaneSpan | null;
  bucket: string | null;
  selected: string | null;
  onSelect: (node: RunNode) => void;
  controls: DetailControls;
  busy: boolean;
  canRun: boolean;
}): JSX.Element {
  const meta = (): (typeof STATUS_META)[RunNode["status"]] =>
    STATUS_META[props.node.status];
  const step = createMemo(() => {
    const push = props.node.push;
    if (push === undefined) return null;
    const { text, as } = pushStep(push, props.bucket);
    const status = STATUS_META[as];
    return { text, hue: status.hue, glyph: status.glyph, span: props.push };
  });
  const hint = (): string =>
    props.node.attempt === 0
      ? "this node has not started, so it has no output yet"
      : `read ${props.node.id}, attempt ${props.node.attempt}`;
  return (
    <li
      class="node"
      classList={{ [`node-${props.node.status}`]: true }}
    >
      <button
        type="button"
        class="node-open"
        classList={{ "node-current": props.selected === props.node.id }}
        onClick={() => props.onSelect(props.node)}
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
        <TitleTooltip text={hint()} />
      </button>
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

/** How far from the bottom still counts as "at the bottom": a fractional
 *  scrollHeight on a zoomed page never lands exactly on zero. */
const STICK_SLACK = 24;

const WRAP_KEY = "odu.web.logWrap";

/** Storage MAY THROW — a private window, a browser set to block site data, a
 *  full quota. */
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
  }
}

function visibleLogText(view: {
  page: LogPage | null;
  followed: string | null;
  tail: LogTail | undefined;
  stream: LogStream;
  faulted: boolean;
}): string {
  if (view.page !== null) return view.page.text;
  const following = view.faulted ? null : view.followed;
  if (view.stream === "push") return following ?? "";
  return following ?? view.tail?.text ?? "";
}

/** On the NEXT task: Solid runs effects after render, but the `<pre>`'s text is
 *  inserted by its own computation, so the height read here is only correct
 *  once that has run. */
function stickToBottom(pane: HTMLPreElement): void {
  queueMicrotask(() => {
    pane.scrollTop = pane.scrollHeight;
  });
}

export function LogPanel(props: {
  node: RunNode | null;
  attempt: number | null;
  onAttempt: (attempt: number) => void;
  stream: LogStream;
  onStream: (stream: LogStream) => void;
  tail: LogTail | undefined;
  followed: string | null;
  followedPage: FollowedPage | null;
  logFault: string | null;
  tailPending: boolean;
  tailError: Error | undefined;
  onPage: (offset: number) => void;
  page: LogPage | null;
}): JSX.Element {
  let pane: HTMLPreElement | undefined;
  const [stuck, setStuck] = createSignal(true);
  const [wrap, setWrap] = createSignal(readWrap());

  const shown = createMemo(() =>
    visibleLogText({
      page: props.page,
      followed: props.followed,
      tail: props.tail,
      stream: props.stream,
      faulted: props.logFault !== null,
    }),
  );

  const growing = createMemo(() =>
    props.stream === "push"
      ? props.node?.push?.state === "pushing"
      : props.tail?.open === true,
  );

  const waiting = createMemo(() =>
    props.stream === "push"
      ? props.followedPage === null &&
        props.page === null &&
        props.logFault === null
      : props.tailPending && props.tail === undefined,
  );

  const spans = createMemo(() => ansiSpans(shown()));

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
    stickToBottom(node);
  });

  return (
    <section class="log" aria-label="Node output">
      <Show
        when={props.node}
        fallback={<p class="empty">select a node</p>}
      >
        {(node) => (
          <div class="log-body">
            <header class="log-head">
              <h3>{node().id}</h3>
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
              <Show when={node().attempt > 1}>
                <span class="attempts" role="group" aria-label="Attempt">
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
                {logMetaText({
                  stream: props.stream,
                  tail: props.tail,
                  followedPage: props.followedPage,
                })}
              </span>
            </header>
            <Show when={props.stream === "recipe" && props.tailError}>
              {(error) => <p class="fault">{String(error())}</p>}
            </Show>
            <Show when={waiting()}>
              <p class="empty">Reading…</p>
            </Show>
            <Show when={props.logFault}>
              {(fault) => <p class="fault">{fault()}</p>}
            </Show>
            <pre
              class="log-text"
              classList={{ "log-wrap": wrap() }}
              tabindex="0"
              ref={pane}
              onScroll={(event) => {
                const el = event.currentTarget;
                setStuck(
                  el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLACK,
                );
              }}
            >
              <Index each={spans()}>
                {(span) => (
                  <span class={span().class} style={{ color: span().color }}>
                    {span().text}
                  </span>
                )}
              </Index>
            </pre>
            <footer class="log-foot">
              <Button
                title="read this log from its first byte, one page at a time"
                onClick={() => props.onPage(0)}
              >
                Read from the start
              </Button>
              <Button
                title="the page before this one"
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
                disabled={props.page === null || props.page.eof}
                onClick={() => props.onPage(props.page?.nextOffset ?? 0)}
              >
                Newer
              </Button>
              <Show when={props.page}>
                {(page) => (
                  <span class="log-page">
                    {`${bytes(page().offset)}–${bytes(page().nextOffset)} of ${bytes(page().size)}`}
                  </span>
                )}
              </Show>
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
              <span class="log-follow">
                <Show
                  when={stuck()}
                  fallback={
                    <Button
                      title="scroll to the end and follow the output again"
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
  bucketHref: (bucket: string) => string;
  now: number;
  pending: boolean;
  error: Error | undefined;
  selected: RunNode | null;
  onSelect: (node: RunNode | null) => void;
  canRun: boolean;
  log: JSX.Element;
  control: ControlState;
  controls: DetailControls;
  onBack: () => void;
}): JSX.Element {
  const busy = createMemo(() => props.control.kind === "pending");
  const live = createMemo(
    () => props.run !== undefined && isActive(props.run),
  );
  const nodes = createMemo<RunNode[]>(() => [...(props.frame?.nodes ?? [])]);
  const laneMap = createMemo(
    () => new Map(lanesOf(nodes()).map((lane) => [lane.platform, lane.nodes])),
  );
  const lanes = createMemo(() => [...laneMap().keys()]);
  const laneNodes = (platform: string): readonly RunNode[] =>
    laneMap().get(platform) ?? [];
  const bucket = createMemo<string | null>(
    () => props.run?.push?.target?.bucket ?? null,
  );
  const pushed = createMemo(() => {
    const total = pushTotals(
      nodes().flatMap((node) =>
        node.push === undefined
          ? []
          : [[node.id, node.push] as readonly [string, NodePush]],
      ),
    );
    return total.landed === 0 && total.failedOn.length === 0 ? null : total;
  });
  const [confirmingCancel, setConfirmingCancel] = createSignal(false);
  return (
    <section class="screen detail">
      <BackLink onClick={props.onBack}>All runs</BackLink>
      <PageHead
        class="detail-head"
        title={
          <>
            {props.run === undefined ? "run" : projectOf(props.run.repoRoot)}
            <Show when={props.run?.branch}>
              {(branch) => <span class="branch">{`/ ${branch()}`}</span>}
            </Show>{" "}
            <Show when={props.run?.outcome}>
              {(outcome) => (
                <Pill hue={OUTCOME[outcome()].hue}>{OUTCOME[outcome()].label}</Pill>
              )}
            </Show>
          </>
        }
        sub={
          <>
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
            <Show when={props.run?.actor}>
              {(actor) => (
                <span class="detail-actor">{`started by ${actor()}`}</span>
              )}
            </Show>
            <span class="detail-sub">{props.run?.repoRoot ?? ""}</span>
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
            <Show when={pushed()}>
              {(total) => (
                <span class="detail-push-total">
                  {pushCounts(total())}
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
            <Show when={nodes().length > 0 ? props.run : undefined}>
              {(run) => (
                <li class="node-axis" aria-hidden="true">
                  <span class="node-axis-track">
                    <Index each={timelineTicks(run(), props.now)}>
                      {(tick) => (
                        <span
                          class="node-axis-tick"
                          style={{ left: `${tick().at * 100}%` }}
                        >
                          {duration(tick().ms)}
                        </span>
                      )}
                    </Index>
                  </span>
                </li>
              )}
            </Show>
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
                        span={
                          props.run === undefined
                            ? null
                            : laneSpan(node(), props.run, props.now)
                        }
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
