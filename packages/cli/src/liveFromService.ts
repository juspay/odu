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

export function attemptRewound(
  page: { offset: number },
  cursor: number | undefined,
): boolean {
  return cursor !== undefined && cursor > 0 && page.offset < cursor;
}

export function nodeStateOf(node: NodesFrame["nodes"][number]): NodeState {
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
    posting: frame.env.owed.length === 0 ? EMPTY_POSTING : { owed: [...frame.env.owed] },
  } as PipelineState;
}

export function headerOf(env: RunEnv, now: number): RunHeader {
  return {
    commitUrl: env.commitUrl,
    lanes: [...env.lanes],
    hostsSource: env.hostsSource,
    startedAt: env.elapsedMs === null ? 0 : now - env.elapsedMs,
  } as RunHeader;
}

export function nodeLogStream(
  client: Pick<OduServiceClient, "surface">,
  logKey: string,
): Stream.Stream<NodeLogFrame, unknown> {
  return S.fromAsyncIterable(pages(client, logKey), (cause) => cause);
}

async function* pages(
  client: Pick<OduServiceClient, "surface">,
  logKey: string,
): AsyncGenerator<NodeLogFrame> {
  let cursor: number | undefined;
  let opened = false;
  for (;;) {
    const page = await runUnary(
      client.surface.log.read({
        key: logKey,
        ...(cursor === undefined ? {} : { offset: cursor }),
        waitMs: FOLLOW_MS,
      }),
    );
    if (attemptRewound(page, cursor)) {
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
    if (!logHasMore(page)) {
      yield { kind: "end" } as NodeLogFrame;
      return;
    }
  }
}

const FOLLOW_MS = 30_000;

export function laneOf(id: string): string {
  return splitFanId(id).platform;
}
