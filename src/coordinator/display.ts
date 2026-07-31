/**
 * `odu run`'s face — three renderings of the same fan-in state, picked by
 * where stdout points:
 *
 *   - `json`  (`--progress json`): one NDJSON line per node transition — the
 *     machine contract `/do` consumes; byte-stable, never styled.
 *   - `plain` (stdout is a pipe/file): one line per transition with glyph +
 *     duration, plus a 60-second heartbeat naming the still-running nodes so
 *     a captured log never *looks* hung between transitions.
 *   - `live`  (stdout is a TTY): a recipes × lanes matrix with spinners,
 *     ticking elapsed times, an events lane, and the focused node's log pane —
 *     drawn on the ALTERNATE screen for the session's lifetime, so nothing it
 *     paints ever enters the operator's scrollback. Failures land in the events
 *     lane inside the frame; the older renderer printed them above the matrix
 *     instead, which is what made the view scroll.
 *
 * The `live` face is the ONE interactive view, shared by `odu run` and `odu
 * attach` through a source-agnostic seam: state is push-fed (`update(state)`
 * — `run`'s coordinator loop and `attach`'s read-loop both call it) and the
 * focused-node log is pull-fed via an injected `openLog(id, signal)` (`run`
 * passes its in-memory tail, `attach` passes the surface's `nodeLog` stream).
 * Keys (digits / hjkl / arrows / r / f / g / G / PgUp / PgDn / `/` / n / q)
 * drive focus, rerun, log scrolling and search through injected callbacks. When
 * non-interactive (a piped `attach`, or a `run` whose stdin isn't a TTY) the
 * keys and the mouse are simply off.
 *
 * Verdict-on-exit is the HOST's policy, not the view's — `run` prints its own
 * `printVerdict`, `attach` asks for `Display.verdict()`. The view leaves the
 * scrollback exactly as it found it. When `hookStderr` (i.e. `run`), library
 * chatter is interposed so surface-remote's `[host:…]` provisioning lines are
 * dropped and everything else becomes an event in the frame; whatever the lane
 * still holds is replayed to the real stderr on teardown, so a fatal message
 * can't die with the alternate screen.
 *
 * `src/cli/liveView.ts` holds the mount-ordering invariants — start() is
 * synchronous while the mount is async, and both stop() and info() have to
 * behave before it lands.
 */

import { LiveView } from "../cli/liveView";
import { formatGoDuration } from "../common/duration";
import { splitFanId } from "../common/nodeId";
import {
  type NodeLogFrame,
  type NodeState,
  type PipelineState,
  type ProgressStatus,
  type RunHeader,
  STATUS_META,
} from "../common/surface";
import { logPathFor } from "./statuses";

/** `stepFocus` moved to `../cli/render` (pure state derivation, where the rest
 *  of the matrix projections live). Re-exported here so existing importers and
 *  their tests keep working against one name. */
export { stepFocus } from "../cli/render";

export type DisplayMode = "json" | "plain" | "live";

export interface ProgressEvent {
  node: string;
  recipe: string;
  platform: string;
  status: ProgressStatus;
  exit_code?: number;
  log: string;
}

/** `3cbac86` for a clean run, `3cbac86+dirty` when the working tree has
 *  uncommitted changes — every face shows which code the verdict is about.
 *  Commit identity lives on `PipelineState`, so the label is fed from state. */
export function commitLabel(
  state: Pick<PipelineState, "sha7" | "dirty">,
): string {
  return state.dirty ? `${state.sha7}+dirty` : state.sha7;
}

export interface Display {
  /** Commit identity comes from `state`; the run-env (lanes, hosts source,
   *  commit link, start clock) from `header`. */
  start(state: PipelineState, header: RunHeader): void;
  /** Latest fan-in state — live repaints from it, plain heartbeats off it. */
  update(state: PipelineState): void;
  /** A node crossed a status boundary (the diff-driven event feed). */
  transition(event: ProgressEvent, node: NodeState): void;
  /** Operator-facing message (post failures, signals, …). */
  info(msg: string): void;
  /** Stop timers, restore the terminal, paint the final frame. */
  stop(state?: PipelineState): void;
  /** A one-line recap of how the run ended, for a host with no verdict of its
   *  own. Only the live face has one — `run` prints its own summary and ignores
   *  this; the json/plain faces already emit every transition. */
  verdict?(): string | undefined;
}

/** The injected dependencies that make the `live` face the shared interactive
 *  view — the source-agnostic seam between `run` (its in-memory tail, raw
 *  stderr to hook, its own shutdown) and `attach` (the surface stream, no
 *  stderr to hook). Push-fed for state (via `Display.update`), pull-fed for the
 *  focused log (via `openLog`). */
export interface LiveOpts {
  /** Read keys + drive focus/rerun/quit; raw-mode the terminal. Off for a
   *  `run` whose stdin isn't a TTY (output-only live matrix). */
  interactive: boolean;
  /** Interpose `process.stderr.write` (drop `[host:…]`, re-print the rest
   *  above the matrix). `run`=true (library chatter shares its stderr);
   *  `attach`=false (an observer has no such chatter to tame). */
  hookStderr: boolean;
  /** Pull the focused node's log: a `snapshot` frame then `append`s, so a
   *  focus change backfills. `run` passes `tail.streamSource` (a synchronous
   *  generator), `attach` passes `client.surface.nodeLog.get` (a promised
   *  stream over the socket) — hence the `| Promise`, `await`ed at the call
   *  site, which is a no-op for the generator. */
  openLog: (
    id: string,
    signal: AbortSignal,
  ) => AsyncIterable<NodeLogFrame> | Promise<AsyncIterable<NodeLogFrame>>;
  /** The one mutation `r` triggers — re-run the focused node. */
  rerun: (id: string) => void;
  /** The interrupt path: `q`/Ctrl-C/Ctrl-D request a quit. The view doesn't
   *  own verdict-on-quit policy — each consumer decides its own exit code (`run`
   *  always 130 for an interrupt; `attach` the current verdict). */
  onQuit: () => void;
}

export function createDisplay(mode: DisplayMode, live?: LiveOpts): Display {
  if (mode === "json") return new JsonDisplay();
  if (mode === "plain") return new PlainDisplay();
  if (live === undefined) {
    throw new Error("odu: createDisplay('live') requires LiveOpts");
  }
  return new LiveDisplay(live);
}

/** Project a node's state into the `ProgressEvent` the json/plain faces emit.
 *  `run` (its own run `sha7`) and `attach` (the surface's `sha7`) both build
 *  events through this one function, so the two faces emit a single
 *  byte-identical `--progress json` / plain contract instead of each
 *  hand-rolling the projection and drifting (the bug in juspay/odu#4).
 *  `null` for a status that emits nothing (`pending`, whose `progress` mapping
 *  is `null`) — the caller skips it. */
export function progressEvent(
  sha7: string,
  id: string,
  node: NodeState,
): ProgressEvent | null {
  const status = STATUS_META[node.status].progress;
  if (status === null) return null;
  const { namepath, platform } = splitFanId(id);
  return {
    node: id,
    recipe: namepath,
    platform,
    status,
    ...(node.exitCode !== null ? { exit_code: node.exitCode } : {}),
    log: logPathFor(sha7, id),
  };
}
// ── json ────────────────────────────────────────────────────────────────────

class JsonDisplay implements Display {
  start(): void {}
  update(): void {}
  transition(event: ProgressEvent): void {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
  info(msg: string): void {
    process.stderr.write(`${msg}\n`);
  }
  stop(): void {}
}

// ── plain ───────────────────────────────────────────────────────────────────

const HEARTBEAT_MS = 60_000;

class PlainDisplay implements Display {
  private state: PipelineState | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastWrite = Date.now();

  start(state: PipelineState, header: RunHeader): void {
    // Commit identity (pipeline name + sha) comes from state; `run` carries
    // lanes + a hosts source on the header, so the banner shows both; an
    // observer (`attach`) has neither, so those clauses drop out and the
    // banner is just `odu · <pipeline> @ <sha>`.
    const parts = [`odu · ${state.name} @ ${commitLabel(state)}`];
    if (header.lanes.length > 0) {
      parts.push(
        header.lanes.map((l) => `${l.platform}=${l.host}`).join(" · "),
      );
    }
    const banner = parts.join(" · ");
    this.say(
      header.hostsSource !== null
        ? `${banner} (hosts: ${header.hostsSource})`
        : banner,
    );
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.timer.unref?.();
  }

  update(state: PipelineState): void {
    this.state = state;
  }

  transition(event: ProgressEvent, node: NodeState): void {
    const glyph = STATUS_META[node.status].glyph;
    const dur =
      node.durationMs !== null ? ` ${formatGoDuration(node.durationMs)}` : "";
    const logRef =
      node.status === "failed" || node.status === "errored"
        ? `  → ${event.log}`
        : "";
    this.say(`${glyph} ${event.status.padEnd(7)} ${event.node}${dur}${logRef}`);
  }

  info(msg: string): void {
    process.stderr.write(`${msg}\n`);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  /** Between transitions a captured log goes silent for however long the
   *  slowest node takes (darwin e2e: ~30 min) — name the laggards once a
   *  minute so the log reads as alive. */
  private heartbeat(): void {
    if (this.state === undefined) return;
    if (Date.now() - this.lastWrite < HEARTBEAT_MS) return;
    const now = Date.now();
    const running = this.state.order
      .map((id) => this.state?.nodes[id])
      .filter((n): n is NodeState => n !== undefined && n.status === "running")
      .map((n) => `${n.id} (${formatGoDuration(now - (n.startedAt ?? now))})`);
    if (running.length > 0) this.say(`… still running: ${running.join(", ")}`);
  }

  private say(line: string): void {
    this.lastWrite = Date.now();
    process.stdout.write(`${line}\n`);
  }
}

// ── live ────────────────────────────────────────────────────────────────────

/** The interactive face, delegated to the opentui view. This class is the
 *  adapter that keeps `Display`'s synchronous contract over a renderer whose
 *  mount is async: `LiveView.start` records state and kicks the mount off
 *  without awaiting, and every other entry point tolerates running before it
 *  lands. See `src/cli/liveView.ts` for what the frame actually does. */
class LiveDisplay implements Display {
  private readonly view: LiveView;
  private sha7 = "";

  constructor(opts: LiveOpts) {
    this.view = new LiveView(opts);
  }

  start(state: PipelineState, header: RunHeader): void {
    this.sha7 = state.sha7;
    this.view.start(state, header);
  }

  update(state: PipelineState): void {
    this.sha7 = state.sha7;
    this.view.update(state);
  }

  transition(event: ProgressEvent, node: NodeState): void {
    this.view.transition(node, event.log !== "" ? event.log : logPathFor(this.sha7, node.id));
  }

  info(msg: string): void {
    this.view.info(msg);
  }

  stop(state?: PipelineState): void {
    this.view.stop(state);
  }

  /** The one-line recap of how the run ended, for a host that has no verdict
   *  of its own. `run` ignores this (it prints its own summary); `attach` prints
   *  it, so leaving the viewport still tells you what happened. */
  verdict(): string | undefined {
    return this.view.verdict();
  }
}
