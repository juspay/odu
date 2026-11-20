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
