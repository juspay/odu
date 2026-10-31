/**
 * THE KEPT PROBE — what the Machines page reads instead of dialling.
 *
 * Two claims: a probe of the SERVICE'S OWN fleet (no caller `hostsFile`) is
 * kept on the `venues` cell with when and for which platforms; a probe naming a
 * caller's hosts file — `odu hosts` forwarding someone's `$ODU_HOSTS` — is
 * answered and NOT kept, so no reader is shown another person's fleet or path.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { buildSurfaceFace } from "@kolu/surface/client";
import { directDispatch } from "@kolu/surface/links/direct";
import { oduServiceSurface, type OduServiceClient } from "@odu/service-client/surface";
import { createOduService } from "./service";
import { makeWorld, recordingPorts, type World } from "./fixture.testlib";

let world: World | null = null;
afterEach(() => {
  world?.dispose();
  world = null;
});

function serve() {
  world = makeWorld();
  const ports = {
    ...recordingPorts(),
    probeVenues: async (request: { platforms: readonly string[] }) => ({
      ok: true as const,
      source: "/etc/odu/hosts.json",
      warnings: [],
      rows: request.platforms.map((platform) => ({
        platform,
        host: "box",
        slot: 0,
        slots: 1,
        state: "free" as const,
        heldBy: null,
        error: null,
      })),
    }),
  };
  const built = createOduService({
    ports,
    origin: "http://127.0.0.1:0",
    home: world.requestsRoot,
    build: { oduVersion: "0.1.0", buildId: "test", commit: "", self: null },
    catalog: { root: world.catalogRoot },
    requestsRoot: world.requestsRoot,
    onDrain: () => {},
  });
  const face = buildSurfaceFace(
    oduServiceSurface,
    directDispatch(built.runtime),
  ) as unknown as OduServiceClient;
  return { face, cell: () => built.runtime.ctx.cells.venues.get(), close: () => built.close() };
}

describe("the venues cell", () => {
  it("is null until the first probe", () => {
    const { cell, close } = serve();
    try {
      expect(cell()).toBeNull();
    } finally {
      close();
    }
  });

  it("keeps a probe of the service's own fleet, with when and for which platforms", async () => {
    const { face, cell, close } = serve();
    try {
      await Effect.runPromise(face.surface.venue.probe({ platforms: ["x86_64-linux"] }));
      const kept = cell();
      expect(kept?.platforms).toEqual(["x86_64-linux"]);
      expect(kept?.rows.map((row) => row.platform)).toEqual(["x86_64-linux"]);
      expect(kept?.at).toBeNumber();
    } finally {
      close();
    }
  });

  it("answers but does not keep a probe of a caller's own hosts file", async () => {
    const { face, cell, close } = serve();
    try {
      const answer = await Effect.runPromise(
        face.surface.venue.probe({ platforms: ["aarch64-darwin"], hostsFile: "/home/someone/hosts.json" }),
      );
      expect(answer.rows).toHaveLength(1);
      expect(cell()).toBeNull();
    } finally {
      close();
    }
  });
});
