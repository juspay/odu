/**
 * The owed-statuses banner — moved here with the function it tests.
 *
 * `postingWarning` used to live in `@odu/execution/coordinator/statuses`, and
 * its tests with it. It is a pure function of `PostingHealth` with no authority
 * in it, and its only caller is a terminal — so keeping it beside the GitHub
 * poster meant the live matrix imported the coordinator's poster to format one
 * sentence, which is how `odu attach` came to drag the engine into a public
 * client. The import wall refused it, correctly, and the fix was to put the
 * rendering where the renderings are.
 */

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
