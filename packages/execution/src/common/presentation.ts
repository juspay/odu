/**
 * The seam between a run and whoever is watching it.
 *
 * A coordinator has to say things: a node moved, a lane died, the run ended
 * this way. It has no business deciding whether those become a matrix on an
 * alternate screen, a line of NDJSON, or nothing at all — that is a property
 * of the face that started it, and the same run is started by a terminal, by a
 * background spawn with a pipe, by an MCP server, and (in the next release) by
 * a service with no terminal anywhere near it.
 *
 * So this module declares what a run EMITS, and `packages/cli/src/runFace.ts` is one
 * implementation of it. The direction is the point: before this seam existed,
 * `packages/execution/src/coordinator/run.ts` imported the TUI to paint itself, which made the
 * engine's dependency closure include a terminal emulator and two reactive
 * runtimes, and made "serve this engine from something that is not a CLI" a
 * refactor rather than a wiring change.
 *
 * {@link ProgressEvent} lives here rather than with the renderer because it is
 * a CONTRACT, not a rendering: it is the `--progress json` line that `/do` and
 * kolu's CI parse, and its bytes are frozen the way a wire schema's are.
 */

import { logPathFor, splitFanId } from "@odu/run-client/nodeId";
import {
  type NodeLogFrame,
  type NodeState,
  type PipelineState,
  type ProgressStatus,
  type RunHeader,
  STATUS_META,
} from "@odu/run-client/surface";
import type { Stream } from "effect";

/** One node transition, as `--progress json` emits it. Byte-stable: a consumer
 *  parses these lines, and `tests/e2e/harness.ts` deliberately re-declares the
 *  shape rather than importing it so a change here shows up as a black-box
 *  failure. */
export interface ProgressEvent {
  node: string;
  recipe: string;
  platform: string;
  status: ProgressStatus;
  exit_code?: number;
  log: string;
}

/**
 * Project a node's state into the `ProgressEvent` the json/plain faces emit.
 *
 * `run` (its own run `sha7`) and `attach` (the surface's `sha7`) both build
 * events through this one function, so the two faces emit a single
 * byte-identical contract instead of each hand-rolling the projection and
 * drifting (the bug in juspay/odu#4). `null` for a status that emits nothing
 * (`pending`, whose `progress` mapping is `null`) — the caller skips it.
 */
export function progressEvent(
  sha7: string,
  id: string,
  node: NodeState,
): ProgressEvent | null {
  // Read off the surface's own metadata table, so a new `NodeStatus` is a
  // compile error there rather than a silent no-event here.
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

/** Where a face gets a node's log from — the live in-memory tail for a run
 *  painting itself, the surface stream for one that attached. */
export type LogSource = (id: string) => Stream.Stream<NodeLogFrame, unknown>;

export interface Display {
  /** Commit identity comes from `state`. The run-env does NOT: it arrives only
   *  through {@link Display.setHeader}, before or after this call. */
  start(state: PipelineState): void;
  /** The run environment, at any time. The ONE way a header reaches a face —
   *  the run header is published twice (once while the venue claim is in
   *  flight, once with the resolved lane→host map, juspay/odu#84), so a second
   *  entry point would only force each implementation to arbitrate between two
   *  headers and get "which one is newer" right by hand. */
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

/** What a face needs FROM the run to be interactive. Supplied by the engine
 *  when it builds its face, so a face never reaches into the coordinator. */
export interface RunFaceSeam {
  /** Pull the focused node's log. */
  openLog: LogSource;
  /** Re-run a node (the live view's `r` key). */
  rerun: (id: string) => void;
  /** The operator asked to leave; the engine decides what that costs. */
  onQuit: () => void;
}

/** Everything the run's final summary needs that its state does not carry. */
export interface VerdictInput {
  state: PipelineState;
  sha7: string;
  dirty: boolean;
  /** The forge page for the commit, when there is one. */
  commitUrl: string | null;
  /** Commit statuses still owed at finalize — reporting debt, shown beside the
   *  verdict and never folded into it. */
  unpostedCount: number;
}

/** One run's face: the live display, and the last thing it says. */
export interface RunFace {
  display: Display;
  /** Print the run's verdict. The EXIT CODE is not this function's to choose —
   *  the engine derives it from the same state, so a face cannot make a red
   *  run exit zero by rendering it wrongly. */
  verdict(input: VerdictInput): void;
}

/** How the engine asks for its face. The engine hands over the seam; the face
 *  decides what medium it is (a TTY matrix, NDJSON, silence). */
export type MakeRunFace = (seam: RunFaceSeam) => RunFace;

/** A face that says nothing.
 *
 *  The DEFAULT, so a caller that only wants a run's exit code — a test, an
 *  embedding — gets one without wiring a renderer, and so `runCommand` has no
 *  hidden dependency on somebody having supplied a terminal. Silence is a
 *  legitimate face; the coordinator's behaviour does not change with it, which
 *  is the property the seam exists to make true. */
export const SILENT_FACE: MakeRunFace = () => ({
  display: {
    start: () => {},
    setHeader: () => {},
    update: () => {},
    transition: () => {},
    info: () => {},
    stop: () => {},
  },
  verdict: () => {},
});
