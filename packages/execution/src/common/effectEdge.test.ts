/**
 * The one behaviour `subscribe` promises that its callers cannot re-derive:
 * what an INTERRUPTION looks like from the Promise side.
 *
 * `effectEdges.test.ts` next door governs WHERE effects may be run; this pins
 * what the edge does with the two ends a subscription can have.
 */

import { describe, expect, it } from "bun:test";
import { Cause, Effect, Stream } from "effect";
import { firstFrame, isNoAnswer, NoAnswerWithin, subscribe } from "./effectEdge";

async function drain<T>(stream: Stream.Stream<T, unknown>): Promise<T[]> {
  const seen: T[] = [];
  for await (const value of subscribe(stream)) seen.push(value);
  return seen;
}

describe("subscribe", () => {
  it("ends the iteration when the stream is interrupted from below", async () => {
    // What a surface client does when its peer closes the socket while the
    // subscription's dial is in flight. `Cause.squash` renders an interrupt-only
    // cause as a bare `Error` reading "All fibers interrupted without error" —
    // no `_tag`, no `cause`, nothing a consumer can branch on but the prose. So
    // it used to escape every classifier odu has and surface as an uncaught,
    // including out of `wait_for_settle`. An interruption is an END.
    const stream = Stream.concat(
      Stream.make(1, 2),
      Stream.failCause(Cause.interrupt(1 as never)) as Stream.Stream<number>,
    );
    expect(await drain(stream)).toEqual([1, 2]);
  });

  it("still rejects on a real failure — an end is not a catch-all", async () => {
    const boom = new Error("the feed died");
    const stream = Stream.concat(
      Stream.make(1),
      Stream.fail(boom) as Stream.Stream<number, Error>,
    );
    await expect(drain(stream)).rejects.toThrow("the feed died");
  });
});

describe("firstFrame", () => {
  it("reads an interruption the same way `subscribe` does", async () => {
    // The rule is the MODULE's, not one member's. A one-shot read is where this
    // interruption actually happens (a peer closing while the dial is in
    // flight), and leaving it unclassified handed `firstSnapshot` /
    // `headerSnapshot` the shapeless `All fibers interrupted without error`
    // instead of the odu-worded protocol failure they raise for exactly this.
    const interrupted = Stream.failCause(
      Cause.interrupt(1 as never),
    ) as Stream.Stream<number>;
    expect(await firstFrame(interrupted)).toBeUndefined();
  });

  it("still rejects on a real failure, so a dropped link is not 'no state'", async () => {
    const stream = Stream.fail(new Error("the feed died")) as Stream.Stream<
      number,
      Error
    >;
    await expect(firstFrame(stream)).rejects.toThrow("the feed died");
  });

  it("rejects with a NAMED no-answer when the head misses its deadline", async () => {
    // Three outcomes, three shapes: a frame, `undefined` for a stream that
    // ended empty, and this for a producer that is there and silent. The last
    // is the hung `odu attach` of juspay/odu#113, which had no way to say so.
    const silent = Stream.fromEffect(Effect.never) as Stream.Stream<number>;
    const outcome = await firstFrame(silent, { deadlineMs: 20 }).then(
      () => "answered",
      (err: unknown) => err,
    );
    expect(isNoAnswer(outcome)).toBe(true);
    expect((outcome as NoAnswerWithin).deadlineMs).toBe(20);
  });

  it("answers normally inside the deadline, and an empty stream is still undefined", async () => {
    expect(await firstFrame(Stream.make(7), { deadlineMs: 1_000 })).toBe(7);
    expect(await firstFrame(Stream.empty, { deadlineMs: 1_000 })).toBeUndefined();
  });
});
