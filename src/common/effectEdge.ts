/**
 * odu's ONE edge between Effect's world and the Promise world its coordinator
 * and CLI are written in — for BOTH member shapes a surface exposes.
 *
 * A unary verb is an `Effect` now, not a `Promise`: there is no other spelling,
 * and `await`ing one silently yields the Effect object instead of dispatching
 * the call (see `runUnary`). A streaming verb is a lazy `Stream`. Neither can
 * be consumed by an `async` function without something running it, and that
 * something lives here, once, so no caller re-derives the rules — nor
 * accidentally invents a second boundary.
 *
 * The file is named for what it IS (the Effect edge) rather than for the first
 * shape it carried, because `src/common/effectEdges.test.ts` enumerates it as
 * odu's only sanctioned `Effect.run*` site and a misnamed edge is how a second
 * one gets added without anyone noticing.
 *
 * Every streaming member used to be `await client.surface.X.get(input, {signal})
 * → AsyncIterable<T>`; under Effect it is `client.surface.X.get(input) →
 * Stream<T>`, returned SYNCHRONOUSLY and LAZY, with no `AbortSignal` anywhere
 * (kolu PLAN D10/#18: cancellation is fiber interruption). Two consequences this
 * module owns so no caller re-derives them:
 *
 *   - **Subscribing is pulling.** A `Stream` value registers nothing; the first
 *     `next()` is what starts the producer. A caller that must be subscribed
 *     BEFORE it causes the event it waits on has to issue that first pull
 *     itself — `runTool`'s coordinator-startup poll and `waitTool`'s settle
 *     watcher both do, and their comments say so.
 *   - **Unsubscribing is `return()`.** Closing the iterator interrupts the fiber
 *     running the stream, which IS the teardown. So the `AbortSignal` a caller
 *     still legitimately owns (a Ctrl+C, an MCP request cancellation, the live
 *     view's focus switch) is wired to `return()` here rather than threaded into
 *     a call option that no longer exists.
 *
 * `return()` is deliberately NOT awaited: a producer parked upstream settles its
 * close late, and awaiting it would stall the next subscription (or a `for
 * await`'s own `break`). The close is fire-and-forget and its rejection is
 * swallowed — closing an already-failed stream can reject, and that rejection is
 * about the teardown, never about the data the caller already read.
 *
 * This is a LEAF, not a receptacle: a bounded algorithm over one call shape,
 * hiding no volatility. `@kolu/surface`'s own `runStreamScoped` is the shared
 * answer but is only reachable through its Solid barrel, which a Node process
 * should not import; kolu's own CLIs carry the same ~25 lines for the same
 * reason, and its W2 reports ask three times for a `./run-stream` subpath.
 */

import { Cause, Effect, Option, Stream } from "effect";

/**
 * Dispatch a UNARY member call and hand back a Promise.
 *
 * `client.surface.<ns>.<verb>(input)` returns an `Effect` — a *description* of
 * the call, not the call. An `Effect` is not a thenable, so
 *
 *     const ack = await client.surface.run.configure(input);   // ← WRONG
 *
 * compiles, resolves `ack` to the Effect object itself, and **never dispatches
 * anything**. It reads exactly like the line that used to be right, which is
 * why kolu banned the shape repo-side after it bit five times in one wave —
 * including one that had quietly disabled the drain a daemon acceptance test
 * existed to prove. `src/common/effectEdges.test.ts` bans it here too.
 *
 * So: an odu caller that genuinely lives in Promise-land runs the call through
 * this function, and nowhere else. `Effect.runPromise` rejects with the
 * SQUASHED failure, i.e. the declared tagged-error instance with its `_tag` and
 * data intact, so a `catch` site can still narrow on it exactly as before.
 *
 * A caller that is ALREADY Effect-shaped — every `BespokeTool.handler`, every
 * surface handler — must NOT use this. It composes the Effect instead, and
 * inherits interruption (an MCP request cancelled mid-call tears the call down
 * through its own finalizers) which this edge, being a Promise, cannot offer.
 */
export async function runUnary<T>(
  call: Effect.Effect<T, unknown>,
): Promise<T> {
  return Effect.runPromise(call);
}

/**
 * The first frame of `stream`, or `undefined` when it ends without emitting.
 *
 * Taking the head ENDS the stream, which releases the subscription through its
 * own finalizers — the Effect equivalent of the old `for await … return`, and
 * the reason this does not leak a held-open `get` on a socket the caller is
 * about to close.
 *
 * `undefined` means the producer genuinely emitted nothing, which every caller
 * treats as a protocol failure and reports as one. A stream that FAILS rejects
 * here rather than collapsing to `undefined`: a dropped link must never read as
 * "the run has no state".
 */
export async function firstFrame<T>(
  stream: Stream.Stream<T, unknown>,
): Promise<T | undefined> {
  return Option.getOrUndefined(await Effect.runPromise(Stream.runHead(stream)));
}

/**
 * Subscribe to `stream` and expose it as an async iterable ITERATOR — usable
 * both hand-advanced (`await sub.next()`, for a first-frame guard) and in a `for
 * await`, over the SAME subscription, so a caller that inspects the opening
 * frame and then pumps the rest opens exactly one.
 *
 * When `signal` is given, its abort unsubscribes: a parked `next()` then
 * resolves `{ done: true }` (the fiber is interrupted, and an interruption is
 * not a failure), so a `for await` ends cleanly instead of throwing — callers
 * distinguish "we tore this down" from "the feed died" by reading the signal,
 * exactly as they did when it was a call option. Omit it for a one-shot read
 * bounded by the stream itself.
 *
 * "An interruption is not a failure" holds for an interruption from EITHER
 * direction — ours through `signal`, or one arriving from below — and the body
 * says why the second half had to be spelled out.
 */
export function subscribe<T>(
  stream: Stream.Stream<T, unknown>,
  signal?: AbortSignal,
): AsyncIterableIterator<T> {
  // AN INTERRUPTION IS AN END, WHEREVER IT CAME FROM — this function's contract
  // (see its doc), honored for interruptions arriving from BELOW as well as for
  // our own abort. A `Stream` whose fiber is interrupted rejects out of
  // `toAsyncIterable` with what `Cause.squash` makes of an interrupt-only cause:
  // a bare `Error` reading `All fibers interrupted without error`, carrying no
  // `_tag`, no `cause`, and nothing else to branch on. Every consumer of this
  // module therefore had one failure it could only recognise by matching that
  // prose, which this repo refuses to do — so it recognised none of them and the
  // shapeless error escaped as an uncaught. It is REACHABLE: a surface client
  // whose peer closes the socket while the subscription's dial is in flight ends
  // this way rather than with the tagged `SurfaceStdioTransportClosed`
  // (measured against a coordinator exiting under `wait_for_settle`).
  //
  // The `Cause` is the only place the fact is legible, and it is still legible
  // HERE, one layer above where the squash happens. So classify here, once,
  // rather than leaving every caller a string comparison.
  const iterator = Stream.toAsyncIterable(
    Stream.catchCause(stream, (cause) =>
      Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
    ),
  )[Symbol.asyncIterator]();
  const unsubscribe = (): void => {
    void Promise.resolve(iterator.return?.()).catch(() => {});
  };
  if (signal !== undefined) {
    if (signal.aborted) unsubscribe();
    else signal.addEventListener("abort", unsubscribe, { once: true });
  }
  return {
    next: () => iterator.next(),
    // Resolve immediately rather than awaiting the close (see the header): the
    // caller is leaving, and the interrupt it just issued needs no witness.
    return: async () => {
      unsubscribe();
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
