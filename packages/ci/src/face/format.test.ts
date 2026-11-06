/**
 * What the run page PROMISES about a push and about the log it is showing.
 *
 * Two claims, both of them defects somebody hit on a real run rather than
 * shapes invented here.
 *
 * **A push says what went up and what was already there.** One count could not:
 * `69 paths` was the number the bucket serves because of a node, and on a warm
 * cache almost none of it was sent by that node. The pair is the fact, the
 * phrase is said in one place, and a run that found nothing already present
 * says nothing about it rather than printing a zero.
 *
 * **A log pane's byte count is about the file it is showing.** The push stream
 * has no tail collection behind it, and the pane used to reach for the
 * recipe's — so the Push tab stated the recipe's size under a heading that
 * said Push. That is the failure mode worth a test: not a missing number, a
 * confident wrong one.
 *
 * These are the two decisions, not the markup around them. The pane itself is
 * `.tsx` and is checked by `compile.test.ts`; what it SAYS is here, where it
 * can be asked without a DOM.
 */

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
    // A node whose whole closure the bucket held: it pushed nothing, and the
    // step that draws it must not read as a push that did nothing at all.
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
    // The defect, exactly: a 9 KiB recipe tail in hand, a push log the follow
    // has not answered for yet. The pane may say it does not know. It may not
    // say 9.0 KiB.
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
