import { describe, expect, it } from "bun:test";
import { absorbSealedLogAppend, isSealedLogAppendError } from "./logTail";

describe("sealed-log append error class", () => {
  it("recognises the throw append raises, and nothing else", () => {
    expect(
      isSealedLogAppendError(
        new Error(
          "logTail: append to fast@x86_64-linux after its log ended — a terminal frame promises no further bytes; call reset() to re-open the log instead",
        ),
      ),
    ).toBe(true);
    expect(isSealedLogAppendError(new Error("EPIPE"))).toBe(false);
    expect(isSealedLogAppendError("after its log ended")).toBe(false);
  });

  it("absorb re-throws a genuine handler bug", () => {
    expect(() => absorbSealedLogAppend(new Error("handler boom"))).toThrow(
      "handler boom",
    );
  });
});
