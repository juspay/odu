/**
 * The one behaviour `subscribe` promises that its callers cannot re-derive:
 * what an INTERRUPTION looks like from the Promise side.
 *
 * `effectEdges.test.ts` next door governs WHERE effects may be run; this pins
 * what the edge does with the two ends a subscription can have.
 */

import { describe, expect, it } from "bun:test";
import { Cause, Stream } from "effect";
import { subscribe } from "./effectEdge";

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
