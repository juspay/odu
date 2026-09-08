import { describe, expect, it } from "bun:test";
import { unpostedNote } from "./verdict";

describe("unpostedNote", () => {
  it("is empty for zero and pluralizes", () => {
    expect(unpostedNote(0)).toBe("");
    expect(unpostedNote(1)).toBe(", 1 status never reached GitHub");
    expect(unpostedNote(3)).toBe(", 3 statuses never reached GitHub");
  });
});
