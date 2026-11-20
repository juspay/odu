import { describe, expect, it } from "bun:test";
import { EMPTY_POSTING } from "@odu/run-client/surface";
import { postingWarning } from "./render";

describe("postingWarning", () => {
  it("is null when healthy", () => {
    expect(postingWarning(EMPTY_POSTING)).toBeNull();
  });

  it("says sending before any attempt, retrying after", () => {
    expect(
      postingWarning({
        owed: [
          { context: "ci::unit@x86_64-linux", lastError: null, attempts: 0 },
        ],
      }),
    ).toMatch(/unconfirmed \(sending\)/);
    const w = postingWarning({
      owed: [
        {
          context: "ci::unit@x86_64-linux",
          lastError: "403 rate limited",
          attempts: 2,
        },
      ],
    });
    expect(w).toMatch(/1 status unconfirmed/);
    expect(w).toMatch(/retrying/);
    expect(w).toMatch(/403 rate limited/);
  });
});
