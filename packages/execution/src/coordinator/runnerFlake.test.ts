import { describe, expect, it } from "bun:test";
import { SURFACE_AGENT_FLAKE_REF_ENV } from "@kolu/surface-remote";
import { requireBakedRunnerSource } from "./runnerFlake";

/** The refusal this file exists for: a coordinator whose wrapper baked no agent
 *  source is a MISBUILT PACKAGE. The trap is that resolving the runner from the
 *  repo under test (the consumer's flake) looks like a helpful fallback and is
 *  exactly the failure juspay/odu#30 fixed — so the refusal has to be pinned,
 *  not left to a comment. */
function withSource(value: string | undefined, fn: () => void): void {
  const previous = process.env[SURFACE_AGENT_FLAKE_REF_ENV];
  if (value === undefined) delete process.env[SURFACE_AGENT_FLAKE_REF_ENV];
  else process.env[SURFACE_AGENT_FLAKE_REF_ENV] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[SURFACE_AGENT_FLAKE_REF_ENV];
    else process.env[SURFACE_AGENT_FLAKE_REF_ENV] = previous;
  }
}

describe("requireBakedRunnerSource", () => {
  it("answers the source flake the wrapper baked — the single source", () => {
    withSource("path:/baked", () => {
      expect(requireBakedRunnerSource()).toBe("path:/baked");
    });
  });

  it("refuses, with no fallback, when the wrapper baked nothing", () => {
    withSource(undefined, () => {
      expect(() => requireBakedRunnerSource()).toThrow(
        new RegExp(SURFACE_AGENT_FLAKE_REF_ENV),
      );
    });
  });

  it("treats a blank bake as unset — still refuses", () => {
    withSource("   ", () => {
      expect(() => requireBakedRunnerSource()).toThrow(
        new RegExp(SURFACE_AGENT_FLAKE_REF_ENV),
      );
    });
  });
});
