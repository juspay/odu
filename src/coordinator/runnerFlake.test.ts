import { describe, expect, it } from "vitest";
import { missingRunnerError, resolveRunnerFlake } from "./runnerFlake";

describe("resolveRunnerFlake", () => {
  it("prefers an explicit --runner-flake over the baked env", () => {
    expect(
      resolveRunnerFlake("github:juspay/odu", {
        ODU_RUNNER_FLAKE: "path:/baked",
      }),
    ).toBe("github:juspay/odu");
  });

  it("falls to the wrapper-baked ODU_RUNNER_FLAKE when no flag is given", () => {
    expect(resolveRunnerFlake(undefined, { ODU_RUNNER_FLAKE: "path:/baked" })).toBe(
      "path:/baked",
    );
  });

  it("refuses (no fallback) when neither flag nor env is set", () => {
    expect(() => resolveRunnerFlake(undefined, {})).toThrow(/no runner flake/);
  });

  it("treats an empty ODU_RUNNER_FLAKE as unset — still refuses", () => {
    expect(() => resolveRunnerFlake(undefined, { ODU_RUNNER_FLAKE: "" })).toThrow(
      /no runner flake/,
    );
  });

  it("never silently uses the repo under test (the #30 trap)", () => {
    // The whole point: with no runner flake, we throw rather than resolving the
    // generic runner from the consumer's flake. Prove the message points the
    // operator at the real knobs, not at re-exporting odu-runner.
    let message = "";
    try {
      resolveRunnerFlake(undefined, {});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/--runner-flake/);
    expect(message).toMatch(/ODU_RUNNER_FLAKE/);
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
    expect(msg).toMatch(/--runner-flake/);
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
