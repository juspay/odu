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
    expect(runPhase(EMPTY_HEADER)).toBe("unstarted");
    expect(runPhase({ ...provisioningHeader(), lanes: [] })).toBe("no_lanes");
  });
});
