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
    expect(maxLaneResurrections({ ODU_MAX_LANE_RESURRECTIONS: "0" })).toBe(0);
  });

  it("refuses what is not a whole number of attempts", () => {
    for (const raw of ["-1", "1.5", "two", "NaN", "Infinity"]) {
      expect(maxLaneResurrections({ ODU_MAX_LANE_RESURRECTIONS: raw })).toBe(2);
    }
  });
});
