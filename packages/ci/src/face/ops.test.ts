/**
 * WHAT THE MACHINES PAGE SAYS ABOUT A READING (PLAN 4.4).
 *
 * The rows themselves are not in doubt: `probeHost` answers an `unreachable`
 * result with ssh's own sentence for a machine that did not reply, and
 * `venueInventory` maps EVERY probed host into a row — so a dead box is a row,
 * not a gap. What this page had to get right is what it says ABOUT those rows,
 * and the three things a screenshot cannot check are pure functions here:
 *
 *   - a `down` row's second line is ssh's words, whole, for the cell's
 *     `title` to carry when the column clips them;
 *   - the hosts file in the toolbar is its last segment, because a
 *     `/nix/store/<hash>-hosts.json` printed in full was the longest string
 *     on the page and the reason that line wrapped;
 *   - the head line counts the kept reading and must say when that reading is
 *     a SLICE. A probe narrowed by the Platforms field replaces it, so after
 *     one narrowed probe this page said "2 of 2 up" about an inventory of ten.
 *
 * The GEOMETRY — fixed columns, no overflow at 1280/1440/1920 — is measured
 * against a live page, not asserted here: a class name proves nothing about a
 * layout, and a width that stopped applying leaves every class where it was.
 */

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
    // A reading with no error text is still a reading: the row must not fall
    // silent and read as a machine that answered.
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
    // A `/nix/store/<32 hex>-hosts.json` printed in full was the longest
    // string on the page. What distinguishes one from another is the end of
    // it; the whole path is still there, on `title`.
    const long = "/nix/store/1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p-odu-hosts.json";
    expect(venueSource(long)).toEqual({ label: "1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p-odu-hosts.json", title: long });
  });

  it("says so when no hosts file answered", () => {
    // Not an empty label: a page that showed nothing there would read as a
    // file it had failed to name rather than as a fleet of local lanes.
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
    // Busy is a machine doing exactly what it is for.
    expect(line).toBe("2 of 3 up");
  });

  it("says what a probe is still waiting on, and how many", () => {
    // The inventory is published before the first dial, so the rows are on
    // screen while an unreachable box burns its ssh timeout. `no probe yet`
    // sat there for the whole of it.
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
    // The number is the rows still OUT, which is what a reader can check
    // against the table under it — not the size of the fleet.
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
    // A narrowed probe is narrowed from its first frame, and a count read as
    // the whole fleet is as wrong before the answer as after it.
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
    // The platform name is the load-bearing part: the line must say WHICH
    // slice this count is of. Pinning the sentence around it would fail on a
    // rewording that changed nothing a reader acts on.
    expect(line).toContain("aarch64-darwin");
  });

  it("says nothing about WHEN — the age is the toolbar's and each row's", () => {
    // One clock, read in one place each. It used to be here, in a `Probed …`
    // facts line and in the toolbar: three bands of chrome over five rows.
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
    // `null` is "the cell answered, and nothing has probed since this service
    // started". A confident `0 of 0 up` there is a claim about a fleet nobody
    // has looked at.
    expect(fleetLine(null)).toBeUndefined();
  });
});
