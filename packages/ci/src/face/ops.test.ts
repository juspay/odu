/**
 * THE MACHINES PAGE'S TWO CLAIMS (PLAN 4.4).
 *
 * The rows themselves are not in doubt: `probeHost` answers an `unreachable`
 * result with ssh's own sentence for a machine that did not reply, and
 * `venueInventory` maps EVERY probed host into a row — so a dead box is a row,
 * not a gap. What this page had to get right is what it says ABOUT those rows,
 * and both halves were wrong in a way a screenshot cannot show:
 *
 *   - a `down` row carried its error with no sense of WHEN. "boxA is down" and
 *     "boxA was down when somebody last looked, forty minutes ago" call for
 *     opposite next moves;
 *   - the head line counted the kept reading and called it the fleet. A probe
 *     narrowed by the Platforms field replaces that reading, so after one
 *     narrowed probe the page said "2 of 2 up" about an inventory of ten.
 *
 * Both are pure functions so they can be stated here; the page is the same two
 * values rendered.
 */

import { describe, expect, it } from "bun:test";
import { fleetLine, venueNote } from "./ops";
import type { VenueRow } from "./types";

const NOW = 1_700_000_000_000;
const FORTY_MINUTES = 40 * 60_000;

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
  it("says it did not answer, how long ago, and what ssh said", () => {
    const note = venueNote(
      machine({
        state: "down",
        error: "ssh: connect to host ci@pureintent port 22: Connection timed out",
      }),
      NOW - FORTY_MINUTES,
      NOW,
    );
    expect(note).toContain("did not answer");
    expect(note).toContain("40m");
    expect(note).toContain("Connection timed out");
  });

  it("still says it did not answer when the probe gave no sentence", () => {
    // A reading with no error text is still a reading: the row must not fall
    // silent and read as a machine that answered.
    const note = venueNote(machine({ state: "down" }), NOW - 60_000, NOW);
    expect(note).toContain("did not answer");
  });

  it("adds nothing to a machine that answered", () => {
    expect(venueNote(machine({ state: "free" }), NOW, NOW)).toBeNull();
    expect(venueNote(machine({ state: "busy" }), NOW, NOW)).toBeNull();
    expect(venueNote(machine({ state: "local" }), NOW, NOW)).toBeNull();
  });
});

describe("the fleet line", () => {
  it("counts only the machines work cannot land on as down", () => {
    const line = fleetLine(
      {
        at: NOW - 60_000,
        platforms: [],
        source: "/etc/odu/hosts.json",
        warnings: [],
        rows: [
          machine({ host: "a" }),
          machine({ host: "b", state: "busy" }),
          machine({ host: "c", state: "down", error: "timed out" }),
        ],
      },
      NOW,
    );
    // Busy is a machine doing exactly what it is for.
    expect(line).toContain("2 of 3 up");
    expect(line).toContain("probed 1m ago");
  });

  it("says a narrowed reading is a SLICE, so its count is not read as the fleet", () => {
    const line = fleetLine(
      {
        at: NOW,
        platforms: ["aarch64-darwin"],
        source: "/etc/odu/hosts.json",
        warnings: [],
        rows: [machine({ platform: "aarch64-darwin", host: "mac" })],
      },
      NOW,
    );
    expect(line).toContain("1 of 1 up");
    expect(line).toContain("aarch64-darwin only, not the whole inventory");
  });

  it("draws no line at all when nothing has probed", () => {
    // `null` is "the cell answered, and nothing has probed since this service
    // started". A confident `0 of 0 up` there is a claim about a fleet nobody
    // has looked at.
    expect(fleetLine(null, NOW)).toBeUndefined();
  });
});
