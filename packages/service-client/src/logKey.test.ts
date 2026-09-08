/**
 * The log key round-trips, and refuses everything else.
 *
 * This token is echoed by hand: a failure names it, an agent pastes it into
 * `log_read`, a browser puts it in a URL. So the only two behaviours that
 * matter are that a key survives the trip unchanged, and that anything else is
 * `null` rather than a partial parse that would address a different attempt's
 * evidence without saying so.
 */

import { describe, expect, it } from "bun:test";
import { formatLogKey, parseLogKey } from "./logKey";

describe("log keys", () => {
  it("round-trips an ordinary node", () => {
    const key = { runId: "0abc-def", node: "unit@x86_64-linux", attempt: 1 };
    expect(parseLogKey(formatLogKey(key))).toEqual(key);
  });

  it("round-trips a namepath, which carries the separator a naive split would break on", () => {
    // `ci::unit` is the ordinary shape of an odu node, and `::` is exactly what
    // a hand-rolled encoding gets wrong once and then gets wrong the same way
    // in both directions.
    const key = { runId: "0abc-def", node: "ci::unit@aarch64-darwin", attempt: 3 };
    expect(parseLogKey(formatLogKey(key))).toEqual(key);
  });

  it("round-trips a sharded node", () => {
    const key = {
      runId: "0abc-def",
      node: "e2e[2-of-4]::install@x86_64-linux",
      attempt: 2,
    };
    expect(parseLogKey(formatLogKey(key))).toEqual(key);
  });

  it("never mints a token carrying the separator it splits on", () => {
    // The property the encoding exists for: an encoded node key is one path
    // segment, so the three fields cannot be miscounted.
    const token = formatLogKey({
      runId: "0abc-def",
      node: "ci::unit@x86_64-linux",
      attempt: 1,
    });
    expect(token.split("/")).toHaveLength(3);
  });

  it("refuses what it did not issue", () => {
    for (const bad of [
      "",
      "nonsense",
      "run/node",
      "run/node/1/extra",
      "run//1",
      "/node/1",
      "run/node/0", // attempts are 1-based; 0 addresses nothing
      "run/node/-1",
      "run/node/x",
    ]) {
      expect(parseLogKey(bad), `"${bad}" should not parse`).toBeNull();
    }
  });
});
