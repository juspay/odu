import { describe, expect, it } from "bun:test";
import {
  absorbSealedLogAppend,
  isSealedLogAppendError,
  SealedLogAppendError,
} from "./logTail";

describe("sealed-log append error class", () => {
  it("recognises the throw append raises, and nothing else", () => {
    expect(
      isSealedLogAppendError(new SealedLogAppendError("fast@x86_64-linux")),
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
