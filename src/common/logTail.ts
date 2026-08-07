/**
 * A per-node log tail: a clamped in-memory buffer plus a delta channel, with
 * lazy creation keyed by node id. One domain concept (`nodeLog`'s server side)
 * that both the runner and the coordinator need — the runner serves it raw, the
 * coordinator composes it with a per-SHA file sink for durability.
 *
 *   - `append(id, text)` — clamp `buffer + text`, publish an `append` frame.
 *   - `reset(id, text)`  — clamp `text` to the buffer, publish a `snapshot`.
 *   - `streamSource`     — the `nodeLog` source: emit the buffered snapshot,
 *                          then forward every later frame off the bus.
 *
 * `Channel<T>` is deliberately unchanged by the Effect migration — it keeps its
 * `subscribe(signal): AsyncIterable<T>` shape, because it is a framework-
 * independent pub/sub leaf. What moved is the SOURCE contract:
 * `StreamImplDeps.source` is now `(input) => Stream<T>` with no signal at all
 * (kolu PLAN D10/#18). `streamFromAbortableSource` is the framework's sanctioned
 * one-conversion bridge for exactly this producer edge, so the abort controller
 * that drives `bus.subscribe` becomes a resource of the stream's own scope:
 * a consumer interrupting its fiber unsubscribes, with nothing to remember.
 */

import {
  type Channel,
  inMemoryChannel,
  streamFromAbortableSource,
} from "@kolu/surface/server";
import type { Stream } from "effect";
import { clampLog, type NodeLogMessage } from "./surface";

export interface LogTail {
  /** The in-memory entry for a node — its tail buffer and its delta channel —
   *  created lazily on first touch. */
  buffer: string;
  bus: Channel<NodeLogMessage>;
}

export interface CreateLogTailResult {
  /** Lazily-created tail entry for a node. */
  logFor: (id: string) => LogTail;
  /** Clamp `buffer + text` and publish an `append` frame. */
  append: (id: string, text: string) => void;
  /** Clamp `text` as the new buffer and publish a `snapshot` frame. */
  reset: (id: string, text: string) => void;
  /** `nodeLog` stream source: snapshot then live deltas for one node. Plugs
   *  straight into `implementSurface`'s `streams.nodeLog.source` slot on all
   *  three servers (the lane runner, the coordinator fan-in, the MCP test
   *  harness), and into the live view's `openLog` seam. */
  streamSource: (input: { id: string }) => Stream.Stream<NodeLogMessage>;
}

export function createLogTail(): CreateLogTailResult {
  const logs = new Map<string, LogTail>();
  const logFor = (id: string): LogTail => {
    let log = logs.get(id);
    if (log === undefined) {
      log = { buffer: "", bus: inMemoryChannel<NodeLogMessage>() };
      logs.set(id, log);
    }
    return log;
  };

  const append = (id: string, text: string): void => {
    const log = logFor(id);
    log.buffer = clampLog(log.buffer + text);
    log.bus.publish({ kind: "append", text });
  };
  const reset = (id: string, text: string): void => {
    const log = logFor(id);
    log.buffer = clampLog(text);
    log.bus.publish({ kind: "snapshot", text: log.buffer });
  };

  const streamSource = ({ id }: { id: string }): Stream.Stream<NodeLogMessage> =>
    streamFromAbortableSource(async function* (signal) {
      // The buffer is read at SUBSCRIBE time, not when the stream value is
      // made: a `Stream` is lazy, and a snapshot taken any earlier would be
      // stale by the time the consumer pulls it.
      const log = logFor(id);
      yield { kind: "snapshot", text: log.buffer } satisfies NodeLogMessage;
      for await (const msg of log.bus.subscribe(signal)) yield msg;
    });

  return { logFor, append, reset, streamSource };
}
