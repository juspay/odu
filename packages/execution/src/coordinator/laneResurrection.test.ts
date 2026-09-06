/**
 * The resurrection budget, with no socket, no git repo and no lane fake — the
 * point of it being a function of an env bag rather than a constant in a
 * 2 900-line orchestrator.
 */

import { describe, expect, it } from "bun:test";
import { maxLaneResurrections } from "./laneResurrection";

describe("maxLaneResurrections", () => {
  it("defaults to two — three lanes in total", () => {
    expect(maxLaneResurrections({})).toBe(2);
    expect(maxLaneResurrections({ ODU_MAX_LANE_RESURRECTIONS: "" })).toBe(2);
  });

  it("takes an operator's budget", () => {
    expect(maxLaneResurrections({ ODU_MAX_LANE_RESURRECTIONS: "4" })).toBe(4);
    expect(maxLaneResurrections({ ODU_MAX_LANE_RESURRECTIONS: "1" })).toBe(1);
  });

  it("reaches ZERO, which is the feature's off switch", () => {
    // `spent < 0` is false on the very first death, so the platform is
    // terminalized on the spot — the pre-feature behaviour. This is the field
    // escape hatch, so it must be genuinely reachable rather than falling back
    // to the default the way a malformed value does.
    expect(maxLaneResurrections({ ODU_MAX_LANE_RESURRECTIONS: "0" })).toBe(0);
  });

  it("refuses what is not a whole number of attempts", () => {
    for (const raw of ["-1", "1.5", "two", "NaN", "Infinity"]) {
      expect(maxLaneResurrections({ ODU_MAX_LANE_RESURRECTIONS: raw })).toBe(2);
    }
  });
});
