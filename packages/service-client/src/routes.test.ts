/**
 * A run address round-trips, and refuses everything that names no run.
 *
 * The two behaviours that matter are the ones a LINK depends on: what a caller
 * mints opens the page the caller meant — the run, or one attempt's output within
 * it — and anything else is `null` rather than a partial read that would navigate
 * somewhere plausible and wrong. The log address is checked with a key carrying
 * `::` and a platform, because that is the ordinary shape of an odu node and the
 * one a hand-rolled split gets wrong.
 */

import { describe, expect, it } from "bun:test";
import { formatLogKey } from "./logKey";
import { logHash, parseRunHash, runHash } from "./routes";

describe("run addresses", () => {
  it("mints and reads the run page", () => {
    expect(runHash("0abc-def")).toBe("#/run/0abc-def");
    expect(parseRunHash("#/run/0abc-def")).toEqual({
      runId: "0abc-def",
      log: null,
    });
  });

  it("mints and reads a log address off the key the wire carries", () => {
    const key = formatLogKey({
      runId: "0abc-def",
      node: "ci::unit@x86_64-linux",
      attempt: 2,
    });
    expect(logHash(key)).toBe(`#/run/${key}`);
    expect(parseRunHash(logHash(key))).toEqual({ runId: "0abc-def", log: key });
  });

  it("falls back to the run page for an address that is not three segments", () => {
    // A truncated or hand-edited address still names a run worth showing; the
    // page opens on the run rather than on a log nobody addressed.
    expect(parseRunHash("#/run/0abc-def/ci::unit@x86_64-linux")).toEqual({
      runId: "0abc-def",
      log: null,
    });
    expect(parseRunHash("#/run/0abc-def/a/1/extra")).toEqual({
      runId: "0abc-def",
      log: null,
    });
  });

  it("reads the spellings a link and a location.hash produce", () => {
    for (const hash of [
      "#/run/0abc-def",
      "/run/0abc-def",
      "run/0abc-def",
    ]) {
      expect(parseRunHash(hash)).toEqual({ runId: "0abc-def", log: null });
    }
  });

  it("refuses anything that names no run", () => {
    for (const hash of ["#/", "#/new", "", "#/run/", "#/runs/0abc-def"]) {
      expect(parseRunHash(hash)).toBeNull();
    }
  });
});
