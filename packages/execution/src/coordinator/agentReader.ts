import { Effect, Stream } from "effect";
import { dialRun } from "@odu/run-client/dial";
import {
  EMPTY_STATE,
  type NodeLogFrame,
  type OduClient,
  type PipelineState,
} from "@odu/run-client/surface";
import {
  type AgentNodesReader,
  toAgentNodes,
} from "../common/agentNodes";

export type OduSurfaceClient = {
  surface: Pick<OduClient["surface"], "nodes" | "nodeLog" | "node" | "lane">;
};

function agentReaderFromA(client: {
  surface: Pick<OduClient["surface"], "nodes">;
}): AgentNodesReader {
  return {
    surface: {
      nodes: {
        get: (_input: void) =>
          Stream.map(client.surface.nodes.get(undefined), toAgentNodes),
      },
    },
  };
}

export type DialA = () => Promise<{
  client: OduSurfaceClient;
  close: () => Promise<void>;
} | null>;

export function dialAFor(socketPath: string): DialA {
  return async () => {
    const dialed = await dialRun(socketPath);
    return dialed === null
      ? null
      : { client: dialed.client, close: dialed.close };
  };
}

export function agentReaderForSocket(socketPath: string): AgentNodesReader {
  return agentReaderFromA(redialingAClient(dialAFor(socketPath)));
}

/**
 * An A-client that dials a fresh coordinator socket for every streaming call
 * and closes it when the consumer stops iterating.
 *
 *   - `nodes.get` — no socket → one `EMPTY_STATE`-shaped frame.
 *   - `nodeLog.get` — no socket → ends immediately.
 *   - `node.rerun` / `node.cancel` / `lane.cancel` — no socket → `{ ok: false }`.
 */
export function redialingAClient(dial: DialA): OduSurfaceClient {
  function streamFresh<F>(
    pick: (a: OduSurfaceClient) => Stream.Stream<F, unknown>,
    onNoRun: Stream.Stream<F>,
  ): Stream.Stream<F, unknown> {
    return Stream.unwrap(
      Effect.map(
        Effect.acquireRelease(
          Effect.promise(() => dial()),
          (dialed) =>
            dialed === null
              ? Effect.void
              : Effect.promise(() => dialed.close()),
        ),
        (dialed) => (dialed === null ? onNoRun : pick(dialed.client)),
      ),
    );
  }

  function callFresh<A extends { readonly ok: boolean }, E>(
    pick: (a: OduSurfaceClient) => Effect.Effect<A, E>,
    onNoRun: A,
  ): Effect.Effect<A, E> {
    return Effect.acquireUseRelease(
      Effect.promise(() => dial()),
      (dialed) => (dialed === null ? Effect.succeed(onNoRun) : pick(dialed.client)),
      (dialed) =>
        dialed === null ? Effect.void : Effect.promise(() => dialed.close()),
    );
  }

  const NO_RUN_ACK: { ok: boolean; recorded?: boolean } = { ok: false };

  return {
    surface: {
      nodes: {
        get: () =>
          streamFresh<PipelineState>(
            (a) => a.surface.nodes.get(undefined),
            Stream.make(EMPTY_STATE),
          ),
      },
      nodeLog: {
        get: (input) =>
          streamFresh<NodeLogFrame>(
            (a) => a.surface.nodeLog.get(input),
            Stream.empty,
          ),
      },
      node: {
        rerun: (input) =>
          callFresh((a) => a.surface.node.rerun(input), NO_RUN_ACK),
        cancel: (input) =>
          callFresh((a) => a.surface.node.cancel(input), NO_RUN_ACK),
      },
      lane: {
        cancel: (input) =>
          callFresh((a) => a.surface.lane.cancel(input), NO_RUN_ACK),
      },
    },
  };
}
