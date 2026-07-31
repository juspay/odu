import { describe, expect, it } from "bun:test";
import { missingRunnerError, resolveRunnerFlake } from "./runnerFlake";

describe("resolveRunnerFlake", () => {
  it("uses the wrapper-baked ODU_RUNNER_FLAKE — the single source", () => {
    expect(resolveRunnerFlake({ ODU_RUNNER_FLAKE: "path:/baked" })).toBe(
      "path:/baked",
    );
  });

  it("refuses (no fallback) when ODU_RUNNER_FLAKE is unset", () => {
    expect(() => resolveRunnerFlake({})).toThrow(/ODU_RUNNER_FLAKE is unset/);
  });

  it("treats an empty ODU_RUNNER_FLAKE as unset — still refuses", () => {
    expect(() => resolveRunnerFlake({ ODU_RUNNER_FLAKE: "" })).toThrow(
      /ODU_RUNNER_FLAKE is unset/,
    );
  });

  it("never silently uses the repo under test (the #30 trap)", () => {
    // The whole point: with no runner flake, we throw rather than resolving the
    // generic runner from the consumer's flake. The message points at odu's own
    // flake, never at re-exporting odu-runner.
    let message = "";
    try {
      resolveRunnerFlake({});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/ODU_RUNNER_FLAKE/);
    expect(message).toMatch(/own flake/);
  });
});

describe("missingRunnerError", () => {
  const flake = "github:juspay/odu";
  const plat = "x86_64-linux";

  it("returns a directed message when nix can't find the odu-runner attribute", () => {
    const stderr =
      "error: flake 'github:juspay/odu' does not provide attribute " +
      "'packages.x86_64-linux.odu-runner.drvPath'";
    const msg = missingRunnerError(flake, plat, stderr);
    expect(msg).not.toBeNull();
    expect(msg).toContain(flake);
    expect(msg).toContain("packages.x86_64-linux.odu-runner");
    expect(msg).toMatch(/ODU_RUNNER_FLAKE/);
  });

  it("also fires on the alternate 'attribute … missing' wording", () => {
    expect(
      missingRunnerError(flake, plat, "error: attribute 'odu-runner' missing"),
    ).not.toBeNull();
  });

  it("returns null for an unrelated failure — the raw stderr must survive", () => {
    expect(
      missingRunnerError(flake, plat, "error: unable to download: Couldn't resolve host"),
    ).toBeNull();
    expect(missingRunnerError(flake, plat, "error: path does not exist")).toBeNull();
  });
});
