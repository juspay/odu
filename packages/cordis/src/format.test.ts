import { describe, expect, it } from "bun:test";
import { ago, ahead } from "./format";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

describe("ago and ahead", () => {
  it("say the same stretch in the same unit, one looking back and one forward", () => {
    for (const [ms, unit] of [
      [30 * 1000, "30s"],
      [5 * 60 * 1000, "5m"],
      [47 * HOUR, "47h"],
      [48 * HOUR, "2d"],
      [83 * 24 * HOUR, "83d"],
    ] as const) {
      expect(ago(NOW - ms, NOW)).toBe(`${unit} ago`);
      expect(ahead(NOW + ms, NOW)).toBe(`in ${unit}`);
    }
  });

  it("never says a negative stretch", () => {
    expect(ahead(NOW - HOUR, NOW)).toBe("in 0s");
    expect(ago(NOW + HOUR, NOW)).toBe("0s ago");
  });
});
