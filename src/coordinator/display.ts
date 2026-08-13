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
 * attach` through the source-agnostic `LiveOpts` seam re-exported below. What
 * the frame draws, which keys it binds, and the mount-ordering invariants that
 * hold it together all live in `src/cli/liveView.ts` — restating them here
 * would be a second copy to keep in sync, which is what this file used to be.
 *
 * Verdict-on-exit is the HOST's policy, not the view's — `run` prints its own
 * `printVerdict`, `attach` prints `verdictLine(state)` from `cli/render`.
 */

import type { LiveOpts, LiveView } from "../cli/liveView";
import {
  claimingText,
  commitLabel,
  laneText,
  operatorLine,
} from "../cli/render";

/** Re-exported from `cli/render`, where the cross-face projections live. */
export { commitLabel };
import { formatGoDuration } from "../common/duration";
import { splitFanId } from "../common/nodeId";
import {
  type NodeState,
  type PipelineState,
  type ProgressStatus,
  type RunHeader,
  STATUS_META,
} from "../common/surface";
import { logPathFor } from "./statuses";

/** The live face's host seam, declared beside the view that consumes it — one
 *  declaration, so a member added to it cannot reach only half the seam. */
export type { LiveOpts };

export type DisplayMode = "json" | "plain" | "live";

export interface ProgressEvent {
  node: string;
  recipe: string;
  platform: string;
  status: ProgressStatus;
  exit_code?: number;
  log: string;
}


export interface Display {
  /** Commit identity comes from `state`; the run-env (lanes, hosts source,
   *  commit link, start clock) from `header`. */
  start(state: PipelineState, header: RunHeader): void;
  /** A NEW run environment for a run already started. The run header is
   *  published twice — once while the venue claim is still in flight, once with
   *  the resolved lane→host map (juspay/odu#84) — so a face that latched its
   *  first header would spend the run showing a lane map that was empty at the
   *  instant it read it. */
  setHeader(header: RunHeader): void;
  /** Latest fan-in state — live repaints from it, plain heartbeats off it. */
  update(state: PipelineState): void;
  /** A node crossed a status boundary (the diff-driven event feed). */
  transition(event: ProgressEvent, node: NodeState): void;
  /** Operator-facing message (post failures, signals, …). */
  info(msg: string): void;
  /** Stop timers, restore the terminal, paint the final frame. */
  stop(state?: PipelineState): void;
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
  // The NDJSON contract is one line per node transition; the run environment
  // never appears in it, so a new header changes nothing to emit.
  setHeader(): void {}
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
  private lanes = "";

  start(state: PipelineState, header: RunHeader): void {
    // Commit identity (pipeline name + sha) comes from state; `run` carries
    // lanes + a hosts source on the header, so the banner shows both; an
    // observer (`attach`) has neither, so those clauses drop out and the
    // banner is just `odu · <pipeline> @ <sha>`. A run that hasn't claimed a
    // machine yet has no lanes to show and says what it is claiming instead.
    this.lanes = laneText(header);
    const parts = [`odu · ${state.name} @ ${commitLabel(state)}`];
    if (this.lanes !== "") parts.push(this.lanes);
    const claiming = claimingText(header);
    if (claiming !== "") parts.push(`claiming ${claiming}`);
    const banner = parts.join(" · ");
    this.say(
      header.hostsSource !== null
        ? `${banner} (hosts: ${header.hostsSource})`
        : banner,
    );
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.timer.unref?.();
  }

  setHeader(header: RunHeader): void {
    const lanes = laneText(header);
    if (lanes === "" || lanes === this.lanes) return;
    this.lanes = lanes;
    this.say(`odu · lanes ${lanes}`);
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

/** The interactive face, delegated to the opentui view.
 *
 *  The view is imported LAZILY. `cli/main.ts` reaches this module for every
 *  command, and a static import of `liveView` drags in @opentui/core's native
 *  library and @xterm/headless — about 125ms, roughly half the wall time of an
 *  `odu runs` or `odu status` that never draws a frame.
 *
 *  This class also keeps `Display`'s synchronous contract over a view whose
 *  construction is now async: state is recorded regardless, and every entry
 *  point tolerates running before the view exists. See `src/cli/liveView.ts`. */
class LiveDisplay implements Display {
  private view: LiveView | undefined;
  /** Queued because `run` calls `info()` during a venue lease that can block
   *  for minutes — long before `start()`, and therefore before the view is
   *  loaded. Pre-view those go straight to stdout, exactly as the view itself
   *  would do pre-mount. */
  /** One field: the two were always written together and read behind a joint
   *  guard, so two independent optionals let the type express states the code
   *  never produces. */
  private pending: { state: PipelineState; header: RunHeader } | undefined;

  constructor(private readonly opts: LiveOpts) {}

  start(state: PipelineState, header: RunHeader): void {
    // A header that arrived before `start` is newer than the one the host is
    // starting us with — prefer it (see `latest`).
    this.pending = { state, header: this.latest ?? header };
    // Caught, not floating: an unhandled rejection here would pick odu's exit
    // code, and odu owns that. Same reasoning as the view's own mount guard.
    void this.load().catch((err: unknown) => {
      process.stderr.write(
        `odu: live view unavailable (${(err as Error).message}) — continuing without it\n`,
      );
    });
  }

  private async load(): Promise<void> {
    const { LiveView: Ctor } = await import("../cli/liveView");
    if (this.stopped) return;
    const view = new Ctor(this.opts);
    this.view = view;
    const pending = this.pending;
    if (pending !== undefined) view.start(pending.state, pending.header);
  }

  private stopped = false;

  /** Reaches the view once it exists; before that it revises the snapshot
   *  `load()` will start it with, so a header published during the venue claim
   *  (while the opentui import is still in flight) isn't lost.
   *
   *  `latest` covers the window before `start()` has run at all — `attach`
   *  opens its header follow-loop before the first `nodes` frame arrives, so a
   *  header can land here with `pending` still undefined. Dropping it silently
   *  would strand the view on a stale lane map for the whole run, because `run`
   *  publishes the header exactly twice and never again. */
  private latest: RunHeader | undefined;

  setHeader(header: RunHeader): void {
    this.latest = header;
    if (this.pending !== undefined) this.pending = { ...this.pending, header };
    this.view?.setHeader(header);
  }

  update(state: PipelineState): void {
    if (this.pending !== undefined) this.pending = { ...this.pending, state };
    this.view?.update(state);
  }

  /** `progressEvent` is the only construction site of a `ProgressEvent` and it
   *  always sets `log` from `logPathFor`, so the old `event.log !== ""`
   *  fallback was unreachable — and the mirrored `sha7` field existed only to
   *  feed it, giving "where does a node's log live" two callers in one file. */
  transition(event: ProgressEvent, node: NodeState): void {
    if (this.view !== undefined) {
      this.view.transition(node, event.log);
      return;
    }
    if (!STATUS_META[node.status].isRed) return;
    const dur =
      node.durationMs !== null ? ` (${formatGoDuration(node.durationMs)})` : "";
    process.stdout.write(
      `${operatorLine(
        `${STATUS_META[node.status].glyph} ${node.id} ${node.status}${dur}  → ${event.log}`,
      )}\n`,
    );
  }

  info(msg: string): void {
    if (this.view !== undefined) {
      this.view.info(msg);
      return;
    }
    process.stdout.write(`${operatorLine(msg)}\n`);
  }

  stop(state?: PipelineState): void {
    this.stopped = true;
    this.view?.stop(state);
  }
}
