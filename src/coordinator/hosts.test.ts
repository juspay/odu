import { describe, expect, it } from "vitest";
import { localFallbackNote, resolveLanes } from "./hosts";

describe("resolveLanes", () => {
  const empty = { hosts: {}, source: "(no hosts file)" };

  it("returns nothing for a bare run with no config — the localhost-default trigger", () => {
    expect(resolveLanes(empty, [], [])).toEqual({});
  });

  it("synthesizes a lane from a --host pin even with no config file", () => {
    expect(resolveLanes(empty, ["aarch64-darwin=localhost"], [])).toEqual({
      "aarch64-darwin": "localhost",
    });
  });

  it("errors on --platform with no host — operator asked for a lane we can't build", () => {
    expect(() => resolveLanes(empty, [], ["x86_64-linux"])).toThrow(
      /no host/,
    );
  });
});

describe("localFallbackNote", () => {
  it("names the detected system and points at the multi-machine escape hatch", () => {
    const note = localFallbackNote("aarch64-darwin");
    expect(note).toContain("running locally on aarch64-darwin");
    expect(note).toContain("hosts.json");
  });
});
