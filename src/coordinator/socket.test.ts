import { describe, expect, it } from "bun:test";
import { socketLogger } from "./socket";

describe("socketLogger", () => {
  it("puts listener faults on the operator feed and keeps routine lifetime off it", () => {
    const lines: string[] = [];
    const log = socketLogger((line) => lines.push(line));

    // Routine: every `odu status` dial ends in a peer close, and bound/closed
    // bracket every healthy run. None of it is an operator's business.
    log.debug({ socketPath: ".ci/odu.sock" }, "unix-socket peer error");
    log.info({ socketPath: ".ci/odu.sock" }, "unix-socket listener bound");
    expect(lines).toEqual([]);

    // A post-listen fault kills attach/status/every agent read while the lanes
    // run on — the comatose-and-silent shape juspay/kolu#2101 was made of.
    log.error(
      { socketPath: ".ci/odu.sock", err: new Error("EPIPE") },
      "unix-socket listener error (post-listen)",
    );
    log.warn({ socketPath: ".ci/odu.sock" }, "something degraded");

    expect(lines).toEqual([
      "odu: unix-socket listener error (post-listen): Error: EPIPE",
      "odu: something degraded",
    ]);
  });
});
