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

/** One node transition, as `--progress json` emits it. Byte-stable: consumers
 *  parse these lines. */
export interface ProgressEvent {
  node: string;
  recipe: string;
  platform: string;
  status: ProgressStatus;
  exit_code?: number;
  log: string;
}

/** Project a node's state into the `ProgressEvent` the json/plain faces emit.
 *  `null` for a status that emits nothing (`pending`). */
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

export type LogSource = (id: string) => Stream.Stream<NodeLogFrame, unknown>;

export interface Display {
  start(state: PipelineState): void;
  /** The run environment, at any time; published twice per run. */
  setHeader(header: RunHeader): void;
  update(state: PipelineState): void;
  transition(event: ProgressEvent, node: NodeState): void;
  info(msg: string): void;
  stop(state?: PipelineState): void;
}

export interface RunFaceSeam {
  openLog: LogSource;
  rerun: (id: string) => void;
  onQuit: () => void;
}

export interface VerdictInput {
  state: PipelineState;
  sha7: string;
  dirty: boolean;
  commitUrl: string | null;
  /** Commit statuses still owed at finalize, never folded into the verdict. */
  unpostedCount: number;
}

export interface RunFace {
  display: Display;
  /** Print the run's verdict. The exit code is the engine's to choose. */
  verdict(input: VerdictInput): void;
}

export type MakeRunFace = (seam: RunFaceSeam) => RunFace;

/** A face that says nothing — the default. */
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
