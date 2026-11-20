import { describe, expect, it } from "bun:test";
import { formatLogKey, parseLogKey } from "./logKey";

describe("log keys", () => {
  it("round-trips an ordinary node", () => {
    const key = { runId: "0abc-def", node: "unit@x86_64-linux", attempt: 1 };
    expect(parseLogKey(formatLogKey(key))).toEqual(key);
  });

  it("round-trips a namepath, which carries the separator a naive split would break on", () => {
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
      "run/node/0",
      "run/node/-1",
      "run/node/x",
    ]) {
      expect(parseLogKey(bad), `"${bad}" should not parse`).toBeNull();
    }
  });
});
