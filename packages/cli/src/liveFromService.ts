/**
 * THE LIVE MATRIX, OVER THE SERVICE — `odu attach`'s dashboard, restored.
 *
 * The matrix was driven by a direct dial into the coordinator's own surface,
 * and that dial is exactly the authority a public command may no longer hold.
 * When `attach` became a client the view went with the dial, and what replaced
 * it was a transition stream: correct, pipeable, and a plain worse thing to sit
 * in front of.
 *
 * It did not have to go. Every fact the view consumes is now on the shared
 * surface — the run's nodes and their statuses on `streams.nodes`, the lane
 * roster and the posting debt on that frame's `env`, an attempt's output
 * through `log.read` with `waitMs`, and `r` through `run.retry`. This module is
 * the adapter, and it is the whole of what was missing.
 *
 * ## Three shapes, and what fills them
 *
 * `liveView` is written against the COORDINATOR's wire types, because that is
 * what it was built on. Rather than rewrite the view — which would mean two
 * matrices to keep identical — the service's shapes are mapped onto it here:
 *
 *   - `NodesFrame` → `PipelineState`. The view reads `order`, `nodes`, their
 *     statuses and timings. It does NOT read `name`, `command` or `needs`
 *     (checked, not assumed), which matters because the catalog deliberately
 *     stores no DAG edges — a run's `needs` is a fact about the justfile at the
 *     commit it ran, and the journal never recorded one. Those three are filled
 *     with the id and empties rather than guessed at.
 *   - `RunEnv` → `RunHeader`. Field for field, and better than the original:
 *     `lanes` here survive the coordinator that reported them.
 *   - `log.read` → `NodeLogFrame`. A `snapshot` then `append`s, ending on
 *     `open: false` — which is the same follow `odu logs -f` runs, so the pane
 *     and the pipe cannot disagree about when a log is finished.
 */

import { type Stream, Stream as S } from "effect";
import { runUnary } from "@odu/execution/common/effectEdge";
import { splitFanId } from "@odu/run-client/nodeId";
import type {
  NodeLogFrame,
  NodeState,
  PipelineState,
  RunHeader,
} from "@odu/run-client/surface";
import { EMPTY_POSTING } from "@odu/run-client/surface";
import type {
  NodesFrame,
  OduServiceClient,
  RunEnv,
  RunRow,
} from "@odu/service-client/surface";
import { logHasMore } from "@odu/service-client/surface";

/** One node, as the view expects it.
 *
 *  `name`, `command` and `needs` are filled rather than carried: the view reads
 *  none of them, and the catalog stores none of them. Inventing a `needs` from
 *  the live coordinator when there is one and leaving it empty when there is
 *  not would be a view that quietly changes shape as a run finishes — which is
 *  the reasoning `RunNodeSchema` already gives for omitting it from the wire. */
function nodeStateOf(node: NodesFrame["nodes"][number]): NodeState {
  return {
    id: node.id,
    name: node.id,
    command: "",
    needs: [],
    status: node.status,
    exitCode: node.exitCode,
    startedAt: node.startedAt,
    durationMs: node.durationMs,
  };
}

/**
 * A frame as the VERDICT reads it — everything `summarize` and `printVerdict`
 * touch, and nothing that needs a board row.
 *
 * Separate from {@link pipelineStateOf} because the caller is: `odu run
 * --progress json` has the frame and the sha it was handed by the receipt, and
 * fetching a row it would use two fields of would be a second read for a
 * heading. The verdict is a fold over nodes; that is all this gives it.
 */
export function verdictStateOf(frame: NodesFrame, sha7: string): PipelineState {
  const nodes: Record<string, NodeState> = {};
  for (const node of frame.nodes) nodes[node.id] = nodeStateOf(node);
  return {
    name: "",
    sha7,
    dirty: false,
    order: [...frame.order],
    nodes,
    posting: frame.env.owed.length === 0 ? EMPTY_POSTING : { owed: [...frame.env.owed] },
  } as PipelineState;
}

/** A whole frame, as the view expects it. */
export function pipelineStateOf(frame: NodesFrame, row: RunRow): PipelineState {
  const nodes: Record<string, NodeState> = {};
  for (const node of frame.nodes) nodes[node.id] = nodeStateOf(node);
  return {
    name: row.pipeline,
    sha7: row.sha.slice(0, 7),
    dirty: row.dirty,
    seq: row.seq,
    order: [...frame.order],
    nodes,
    // The debt, in the shape the view's banner reads. Carried rather than
    // dropped: "this run's verdict is sound and its reporting is not" is
    // exactly the thing an operator watching a matrix needs told.
    posting: frame.env.owed.length === 0 ? EMPTY_POSTING : { owed: [...frame.env.owed] },
  } as PipelineState;
}

/** The run environment, as the view's banner expects it.
 *
 *  `startedAt` is reconstructed from `elapsedMs` because the view wants an
 *  absolute instant and the wire carries a duration — a duration being the
 *  right thing on the wire, since it is what stops at the verdict rather than
 *  counting forever. */
export function headerOf(env: RunEnv, now: number): RunHeader {
  return {
    commitUrl: env.commitUrl,
    lanes: [...env.lanes],
    hostsSource: env.hostsSource,
    startedAt: env.elapsedMs === null ? 0 : now - env.elapsedMs,
  } as RunHeader;
}

/**
 * One node's output as the view's log protocol — a snapshot, then appends,
 * then `end`.
 *
 * Built on `log.read` with `waitMs`, which is the same follow `odu logs -f`
 * runs. That is deliberate: two implementations of "when is a log finished"
 * would eventually disagree, and the pane and the pipe would stop at different
 * bytes on the same attempt.
 *
 * `end` when the page says `open: false` — the log's producer has had its last
 * word, or the run reached a terminal record, or its owner is provably gone. A
 * pane that inferred the end from `eof` alone would hold a spinner forever on
 * the log of a coordinator that was killed.
 */
export function nodeLogStream(
  client: Pick<OduServiceClient, "surface">,
  logKey: string,
): Stream.Stream<NodeLogFrame, unknown> {
  return S.fromAsyncIterable(pages(client, logKey), (cause) => cause);
}

/** The follow, as frames. An async generator rather than Effect combinators
 *  because that is what this is — a loop holding one cursor — and the framing
 *  rules are easier to check when they read in order. */
async function* pages(
  client: Pick<OduServiceClient, "surface">,
  logKey: string,
): AsyncGenerator<NodeLogFrame> {
  let cursor: number | undefined;
  let opened = false;
  for (;;) {
    // Through the shared Effect edge, not a local `runPromise`: `runUnary` is
    // where the dispatch and teardown rules for a surface call live, and a
    // second boundary beside it is what `effectEdges.test.ts` exists to refuse.
    const page = await runUnary(
      client.surface.log.read({
        key: logKey,
        ...(cursor === undefined ? {} : { offset: cursor }),
        waitMs: FOLLOW_MS,
      }),
    );
    // A REWRITE, not a resume. A rerun rewrites an attempt's log in place, so
    // the file can be shorter than the cursor; the read clamps, and `offset`
    // coming back below what we asked for is the only signal. The pane starts
    // over — `snapshot` is what tells it to — rather than showing the tail of a
    // different attempt as a continuation of this one.
    if (cursor !== undefined && cursor > 0 && page.offset < cursor) {
      cursor = 0;
      opened = false;
      continue;
    }
    cursor = page.nextOffset;
    if (page.text !== "") {
      yield opened
        ? ({ kind: "append", text: page.text } as NodeLogFrame)
        : ({ kind: "snapshot", text: page.text } as NodeLogFrame);
      opened = true;
    }
    // `end` when the log can no longer grow AND this read reached its end —
    // `logHasMore`'s rule, which is the CLI's and the browser's too. Ending on
    // `!open` alone dropped whatever the closing page carried: a producer that
    // finishes after appending more than one page hands back an unread
    // remainder with `open: false`, and the pane threw away the last screenful
    // of the log somebody had opened it to read.
    if (!logHasMore(page)) {
      yield { kind: "end" } as NodeLogFrame;
      return;
    }
  }
}

/** One followed read's deadline — `run.wait`'s, deliberately. A longer one
 *  would hold a request open past what any proxy between a browser and the
 *  service will tolerate, and the loop re-issues anyway. */
const FOLLOW_MS = 30_000;

/** Which node the caller's `r` means, resolved against what is on screen —
 *  the view hands back an id it drew, so this is a pass-through kept as a
 *  named seam for the retry call site. */
export function laneOf(id: string): string {
  return splitFanId(id).platform;
}
