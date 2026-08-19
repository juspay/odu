/**
 * A per-node log tail: a clamped in-memory buffer plus a delta channel, with
 * lazy creation keyed by node id. One domain concept (`nodeLog`'s server side)
 * that both the runner and the coordinator need — the runner serves it raw, the
 * coordinator composes it with a per-SHA file sink for durability.
 *
 *   - `append(id, text)` — clamp `buffer + text`, publish an `append` frame.
 *   - `reset(id, text)`  — clamp `text` to the buffer, publish a `snapshot`.
 *   - `end(id)`          — this node's log is COMPLETE; publish the terminal.
 *   - `streamSource`     — the `nodeLog` source: emit the buffered snapshot,
 *                          then forward every later frame off the bus.
 *
 * A node's log is finite — its process closes its stdio, or the node reaches a
 * terminal status without ever running — and `end` is the only place that fact
 * is representable. It is what lets a reader tell "still arriving" from "that
 * was all", which the coordinator needs before it may tear a lane down
 * (juspay/odu#87). `end` is idempotent, and `reset` RE-OPENS an ended log: a
 * rerun starts the node's output over, so its stream gets a fresh terminal too.
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
  /** This node has produced all the output it ever will. Latched by `end`,
   *  cleared by `reset` (a rerun re-opens the log). Kept on the entry — not
   *  inferred from the channel — because `inMemoryChannel` has no publisher-side
   *  close, and because a LATE subscriber must learn completion too: it missed
   *  the `end` frame, so `streamSource` replays one after the snapshot. */
  ended: boolean;
}

export interface CreateLogTailResult {
  /** Lazily-created tail entry for a node. */
  logFor: (id: string) => LogTail;
  /** Clamp `buffer + text` and publish an `append` frame. */
  append: (id: string, text: string) => void;
  /** Clamp `text` as the new buffer and publish a `snapshot` frame. Re-opens an
   *  ended log — the node is about to produce output again. */
  reset: (id: string, text: string) => void;
  /** Latch this node's log complete and publish the terminal `end` frame.
   *  Idempotent: a node reaches its terminal status once, but several teardown
   *  paths may say so. */
  end: (id: string) => void;
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
      log = { buffer: "", bus: inMemoryChannel<NodeLogMessage>(), ended: false };
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
    log.ended = false;
    log.bus.publish({ kind: "snapshot", text: log.buffer });
  };
  const end = (id: string): void => {
    const log = logFor(id);
    if (log.ended) return;
    log.ended = true;
    log.bus.publish({ kind: "end" });
  };

  const streamSource = ({ id }: { id: string }): Stream.Stream<NodeLogMessage> =>
    streamFromAbortableSource(async function* (signal) {
      // The buffer is read at SUBSCRIBE time, not when the stream value is
      // made: a `Stream` is lazy, and a snapshot taken any earlier would be
      // stale by the time the consumer pulls it.
      const log = logFor(id);
      // Register on the bus BEFORE reading the buffer, and read `ended` in the
      // same synchronous breath as the snapshot: a frame published between the
      // two would otherwise be neither in the snapshot nor on our subscription.
      const deltas = log.bus.subscribe(signal)[Symbol.asyncIterator]();
      const snapshot = log.buffer;
      const alreadyEnded = log.ended;
      yield { kind: "snapshot", text: snapshot } satisfies NodeLogMessage;
      // A subscriber that arrives after the node finished missed its `end`;
      // replay one so completion is a property of the LOG, not of when you
      // happened to attach.
      if (alreadyEnded) yield { kind: "end" } satisfies NodeLogMessage;
      for (;;) {
        const next = await deltas.next();
        if (next.done === true) return;
        yield next.value;
      }
    });

  return { logFor, append, reset, end, streamSource };
}
