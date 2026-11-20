import { describe, expect, it } from "bun:test";
import { logPathFor } from "./nodeId";

describe("logPathFor", () => {
  it("keeps the ci:: prefix in the filename, platform as the directory", () => {
    expect(logPathFor("338eb01", "ci::e2e@x86_64-linux")).toBe(
      ".ci/338eb01/x86_64-linux/ci::e2e.log",
    );
  });

  it("handles the unprefixed _ci-setup bookkeeping node", () => {
    expect(logPathFor("338eb01", "_ci-setup@aarch64-darwin")).toBe(
      ".ci/338eb01/aarch64-darwin/_ci-setup.log",
    );
  });
});
