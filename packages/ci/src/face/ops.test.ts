import { describe, expect, it } from "bun:test";
import { fleetLine, venueNote, venueSource } from "./ops";
import type { VenueRow } from "./types";

const NOW = 1_700_000_000_000;

function machine(over: Partial<VenueRow> = {}): VenueRow {
  return {
    platform: "x86_64-linux",
    host: "ci@pureintent",
    slot: 0,
    slots: 1,
    state: "free",
    heldBy: null,
    error: null,
    ...over,
  };
}

describe("an unreachable machine's row", () => {
  it("carries ssh's own sentence, which no column could hold", () => {
    expect(
      venueNote(
        machine({
          state: "down",
          error: "ssh: connect to host ci@pureintent port 22: Connection timed out",
        }),
      ),
    ).toBe("ssh: connect to host ci@pureintent port 22: Connection timed out");
  });

  it("still says something when the probe gave no sentence", () => {
    expect(venueNote(machine({ state: "down" }))).toContain("did not answer");
  });

  it("adds nothing to a machine that answered", () => {
    expect(venueNote(machine({ state: "free" }))).toBeNull();
    expect(venueNote(machine({ state: "busy" }))).toBeNull();
    expect(venueNote(machine({ state: "local" }))).toBeNull();
  });
});

describe("the hosts file in the toolbar", () => {
  it("is its last segment, with the whole path to hover", () => {
    const long = "/nix/store/1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p-odu-hosts.json";
    expect(venueSource(long)).toEqual({ label: "1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p-odu-hosts.json", title: long });
  });

  it("says so when no hosts file answered", () => {
    expect(venueSource(null).label).toBe("local lanes only");
  });
});

describe("the fleet line", () => {
  it("counts only the machines work cannot land on as down", () => {
    const line = fleetLine({
      at: NOW - 60_000,
      platforms: [],
      source: "/etc/odu/hosts.json",
      warnings: [],
      rows: [
        machine({ host: "a" }),
        machine({ host: "b", state: "busy" }),
        machine({ host: "c", state: "down", error: "timed out" }),
      ],
    });
    expect(line).toBe("2 of 3 up");
  });

  it("says what a probe is still waiting on, and how many", () => {
    const line = fleetLine({
      at: NOW,
      platforms: [],
      source: "/etc/odu/hosts.json",
      warnings: [],
      rows: [
        machine({ host: "a", state: "probing" }),
        machine({ host: "b", state: "probing" }),
        machine({ host: "c", state: "free" }),
      ],
    });
    expect(line).toBe("probing 2 hosts…");
  });

  it("counts one host singular, because a sentence is read not parsed", () => {
    const line = fleetLine({
      at: NOW,
      platforms: [],
      source: null,
      warnings: [],
      rows: [machine({ host: "a", state: "probing" })],
    });
    expect(line).toBe("probing 1 host…");
  });

  it("keeps the slice clause while it is still probing", () => {
    const line = fleetLine({
      at: NOW,
      platforms: ["aarch64-darwin"],
      source: null,
      warnings: [],
      rows: [machine({ platform: "aarch64-darwin", host: "mac", state: "probing" })],
    });
    expect(line).toContain("probing 1 host…");
    expect(line).toContain("aarch64-darwin");
  });

  it("says a narrowed reading is a SLICE, so its count is not read as the fleet", () => {
    const line = fleetLine({
      at: NOW,
      platforms: ["aarch64-darwin"],
      source: "/etc/odu/hosts.json",
      warnings: [],
      rows: [machine({ platform: "aarch64-darwin", host: "mac" })],
    });
    expect(line).toContain("1 of 1 up");
    expect(line).toContain("aarch64-darwin");
  });

  it("says nothing about WHEN — the age is the toolbar's and each row's", () => {
    const line = fleetLine({
      at: NOW - 60_000,
      platforms: [],
      source: null,
      warnings: [],
      rows: [machine({ host: "a" })],
    });
    expect(line).not.toContain("ago");
  });

  it("draws no line at all when nothing has probed", () => {
    expect(fleetLine(null)).toBeUndefined();
  });
});
