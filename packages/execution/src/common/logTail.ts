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
 * `append` after `end` THROWS: the terminal is a promise to every reader that
 * nothing more is coming, and a producer with more to say must re-open the log.
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
import { clampLog, type NodeLogMessage } from "@odu/run-client/surface";

/** The in-memory entry for a node — its tail buffer and its delta channel —
 *  created lazily on first touch. Deliberately NOT exported: `buffer` and
 *  `ended` are this module's own state, and a consumer that reads them is
 *  coding against the implementation instead of the contract — which is
 *  precisely how the fan-in's emptiness guard came to be wrong. Every question
 *  a consumer has about a log is a named query on {@link CreateLogTailResult}. */
interface LogTail {
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
  /** Clamp `buffer + text` and publish an `append` frame. Throws on a log that
   *  has already ended — see the body for why that is loud rather than lenient. */
  append: (id: string, text: string) => void;
  /** Clamp `text` as the new buffer and publish a `snapshot` frame. Re-opens an
   *  ended log — the node is about to produce output again. */
  reset: (id: string, text: string) => void;
  /** Latch this node's log complete and publish the terminal `end` frame.
   *  Idempotent: a node reaches its terminal status once, but several teardown
   *  paths may say so. */
  end: (id: string) => void;
  /** Would `reset(id, text)` change anything a reader can observe? False only
   *  for an empty snapshot over an empty, still-open log: nothing to show,
   *  nothing to withdraw, no terminal to lift.
   *
   *  Named HERE, beside the state it interrogates, because every observable a
   *  log has lives in this module — so adding one means extending this
   *  predicate, not bolting a further clause onto each caller's `if`. Which is
   *  exactly how the clause about the `ended` latch came to be missing. */
  isNoopReset: (id: string, text: string) => boolean;
  /** Has this node published its terminal? Asked rather than read off the
   *  entry, so "is this log finished" stays the tail's fact to answer and not a
   *  predicate every caller re-derives from raw fields. */
  isEnded: (id: string) => boolean;
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
    // Loud, not lenient. `end` told every reader this node had produced all the
    // output it ever will, and a reader that acted on it (`odu logs -f` breaks
    // out of its loop the moment it lands) is already gone — so bytes published
    // here are bytes nobody will ever see, the exact class of silent loss this
    // protocol exists to remove. A producer with more to say must `reset` and
    // re-open the log. Anything else is an ordering bug in the caller, and it
    // fails fast here instead of being maintained by a comment in another
    // module about which ids are safe to keep writing to.
    if (log.ended) {
      throw new Error(
        `logTail: append to ${id} after its log ended — a terminal frame promises no further bytes; call reset() to re-open the log instead`,
      );
    }
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

  const isEnded = (id: string): boolean => logFor(id).ended;

  const isNoopReset = (id: string, text: string): boolean => {
    const log = logFor(id);
    return text === "" && log.buffer === "" && !log.ended;
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
      // `subscribe()` adds the subscriber to the registry before it RETURNS
      // (see `inMemoryChannel` in @kolu/surface), which is why holding the
      // iterable is already the registration — the framework's own
      // `subscribeBeforeSnapshot` acquires it exactly this way.
      const deltas = log.bus.subscribe(signal);
      const snapshot = log.buffer;
      const alreadyEnded = log.ended;
      yield { kind: "snapshot", text: snapshot } satisfies NodeLogMessage;
      // A subscriber that arrives after the node finished missed its `end`;
      // replay one so completion is a property of the LOG, not of when you
      // happened to attach.
      //
      // Re-read the latch: the `yield` above SUSPENDS this generator, and a
      // rerun's `reset` in that window re-opens the log. Replaying the stale
      // `alreadyEnded` would then forge completion for an invocation that is
      // starting over — `logs -f` breaks on the first `end`, so it would exit
      // and never show the new output. The reopening snapshot is already
      // queued on `deltas`; letting it through is the whole fix.
      if (alreadyEnded && log.ended) yield { kind: "end" } satisfies NodeLogMessage;
      // `yield*` over the iterable is self-cleaning — the consumer leaving
      // calls `return()` on it — so the abort controller stays the teardown of
      // last resort rather than the only one.
      yield* deltas;
    });

  return { append, reset, end, isEnded, isNoopReset, streamSource };
}

/** The throw `append` raises on a sealed log — the one class a fire-and-forget
 *  log tap may absorb. Anything else is a handler bug and must stay loud. */
export function isSealedLogAppendError(err: unknown): err is Error {
  return err instanceof Error && err.message.includes("after its log ended");
}

/** Re-throw unless this is a sealed-log append. The absorbed case is written
 *  to stderr: never picking the process exit code is not the same as leaving
 *  no trace. */
export function absorbSealedLogAppend(err: unknown): void {
  if (!isSealedLogAppendError(err)) throw err;
  process.stderr.write(`odu: ${err.message}\n`);
}
