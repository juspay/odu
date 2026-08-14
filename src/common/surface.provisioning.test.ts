/**
 * `runPhase` — where a run is in its lifecycle as far as the *environment* is
 * concerned (juspay/odu#84), derived from the lane roster rather than stored
 * beside it. Colocated with the module that owns it; the faces that render the
 * phase are tested in `src/cli/introspect.provisioning.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import { EMPTY_HEADER, type RunHeader, runPhase } from "./surface";

function provisioningHeader(startedAt = 1_000): RunHeader {
  return {
    commitUrl: null,
    lanes: [
      {
        state: "claiming",
        platform: "x86_64-linux",
        pool: ["kolu-ci-5", "kolu-ci-6"],
      },
    ],
    hostsSource: "~/.config/odu/hosts.json",
    startedAt,
  };
}

function lanesHeader(): RunHeader {
  return {
    commitUrl: null,
    lanes: [{ state: "leased", platform: "x86_64-linux", host: "kolu-ci-5" }],
    hostsSource: "~/.config/odu/hosts.json",
    startedAt: 1_000,
  };
}

describe("runPhase", () => {
  it("is provisioning while any lane is still claiming", () => {
    expect(runPhase(provisioningHeader())).toBe("provisioning");
  });

  it("is lanes once every lane has a host", () => {
    expect(runPhase(lanesHeader())).toBe("lanes");
  });

  it("reads a partly-claimed multi-platform run as provisioning", () => {
    // One lane resolved, one still claiming: the run has not reached its
    // fanout, so it is not in the `lanes` phase yet.
    expect(
      runPhase({
        ...lanesHeader(),
        lanes: [
          { state: "leased", platform: "aarch64-darwin", host: "rasam" },
          {
            state: "claiming",
            platform: "x86_64-linux",
            pool: ["kolu-ci-5", "kolu-ci-6"],
          },
        ],
      }),
    ).toBe("provisioning");
  });

  it("tells a run that never started apart from one that got nothing", () => {
    // These were ONE value (`no_lanes`) until the lens review, distinguishable
    // only by `elapsed_ms` on a sibling JSON field — a precondition-on-a-sibling
    // exactly like the one the phase enum exists to abolish. A pre-publish
    // header is `unstarted`; a run that tried and got no machine is `no_lanes`.
    expect(runPhase(EMPTY_HEADER)).toBe("unstarted");
    expect(runPhase({ ...provisioningHeader(), lanes: [] })).toBe("no_lanes");
  });
});
