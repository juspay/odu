import { describe, expect, it } from "bun:test";
import { Cause, Effect, Stream } from "effect";
import {
  errorMessage,
  errorStack,
  firstFrame,
  isNoAnswer,
  NoAnswerWithin,
  subscribe,
} from "./effectEdge";

async function drain<T>(stream: Stream.Stream<T, unknown>): Promise<T[]> {
  const seen: T[] = [];
  for await (const value of subscribe(stream)) seen.push(value);
  return seen;
}

describe("subscribe", () => {
  it("ends the iteration when the stream is interrupted from below", async () => {
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

describe("errorMessage", () => {
  it("renders an Error's message, or its name when the message is empty", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage(new Error(""))).toBe("Error");
  });
  it("renders a bare string", () => {
    expect(errorMessage("raw line")).toBe("raw line");
  });
  it("renders an object's string message, else the value itself", () => {
    expect(errorMessage({ message: "nested cause" })).toBe("nested cause");
    expect(errorMessage({ code: "E_DIED" })).toBe('{"code":"E_DIED"}');
    expect(errorMessage({ x: "A".repeat(600) })).toHaveLength(513);
    expect(errorMessage(null)).toBe("null");
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => errorMessage(cyclic)).not.toThrow();
    expect(errorMessage(13n)).toBe("13");
  });
});

describe("errorStack", () => {
  it("uses the Error's stack when there is one, else the message render", () => {
    const boom = new Error("boom");
    const stack = boom.stack;
    if (stack === undefined) throw new Error("Error() carries a stack");
    expect(errorStack(boom)).toBe(stack);
    expect(errorStack("raw line")).toBe("raw line");
  });
});
