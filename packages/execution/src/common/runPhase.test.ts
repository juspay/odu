/**
 * `runPhase` — where a run is in its lifecycle as far as the *environment* is
 * concerned (juspay/odu#84), derived from the lane roster rather than stored
 * beside it. The fold itself now lives in `@odu/run-client/surface` — a client
 * of the socket reads the phase rather than re-deriving it — but its test stays
 * here, with odu's shared `RunHeader` fixtures; the faces that RENDER the phase
 * are tested in `packages/cli/src/introspect.provisioning.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import { EMPTY_HEADER, runPhase } from "@odu/run-client/surface";
import { lanesHeader, provisioningHeader } from "./scaffoldForTest";

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
