import { describe, expect, it } from "bun:test";
import { logMetaText, pushCounts } from "./format";

describe("pushCounts", () => {
  it("tells what went up apart from what the bucket already had", () => {
    expect(pushCounts({ stored: 3, present: 66, bytes: 3_174 })).toBe(
      "3 pushed · 66 present · 3.1 KiB",
    );
  });

  it("says nothing about `present` when there was none", () => {
    const said = pushCounts({ stored: 12, present: 0, bytes: 1_024 });
    expect(said).not.toContain("present");
    expect(said).toBe("12 pushed · 1.0 KiB");
  });

  it("still counts the bytes when every path was already there", () => {
    expect(pushCounts({ stored: 0, present: 40, bytes: 0 })).toBe(
      "0 pushed · 40 present · 0 B",
    );
  });
});

describe("logMetaText", () => {
  const tail = { totalBytes: 9_216, complete: true } as Parameters<
    typeof logMetaText
  >[0]["tail"];

  it("states the push stream's own size as soon as the follow has a page", () => {
    expect(
      logMetaText({
        stream: "push",
        tail,
        followedPage: { size: 3_174, complete: true },
      }),
    ).toBe("push log · 3.1 KiB");
  });

  it("never borrows the recipe's size for the push stream", () => {
    const said = logMetaText({ stream: "push", tail, followedPage: null });
    expect(said).toBe("push log");
    expect(said).not.toContain("9.0 KiB");
  });

  it("marks a push log whose producer never closed it", () => {
    expect(
      logMetaText({
        stream: "push",
        tail,
        followedPage: { size: 512, complete: false },
      }),
    ).toContain("incomplete");
  });

  it("reads the recipe's size off the tail, and says nothing without one", () => {
    expect(logMetaText({ stream: "recipe", tail, followedPage: null })).toBe(
      "9.0 KiB",
    );
    expect(
      logMetaText({
        stream: "recipe",
        tail: undefined,
        followedPage: { size: 3_174, complete: true },
      }),
    ).toBe("");
  });
});
