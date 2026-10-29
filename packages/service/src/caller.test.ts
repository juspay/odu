/**
 * THE CALLER, ASSEMBLED — five verbs, one value.
 *
 * `hostsFile` used to travel as a loose field on every port signature, with the
 * same sentence copied onto each: the service is a per-user singleton, so its
 * environment is a fact about the shell that started it and never about the
 * person asking. The value those ports received was always `input.hostsFile ??
 * null`; this suite pins that READING at all five doors, because the three
 * spellings are not interchangeable:
 *
 *   - a path names a fleet,
 *   - `""` says the caller's shell had none, and
 *   - absent says the caller has no shell at all (an agent, a browser) and the
 *     service's own configuration stands.
 *
 * If assembly ever moves — to the connection, as a later PR does — these are
 * the assertions that see it move, and the only ones that have to.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { buildSurfaceFace } from "@kolu/surface/client";
import { directDispatch } from "@kolu/surface/links/direct";
import {
  oduServiceSurface,
  type OduServiceClient,
} from "@odu/service-client/surface";
import type { Caller } from "./ports";
import { createOduService } from "./service";
import {
  makeWorld,
  recordingPorts,
  type RecordingPorts,
  type World,
} from "./fixture.testlib";

const CHECKOUT = "/code/app";
const PLATFORM = "x86_64-linux";
const HEAD = "a".repeat(40);

let world: World | null = null;
afterEach(() => {
  world?.dispose();
  world = null;
});

function serve(ports: RecordingPorts) {
  world = makeWorld();
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
  return { face, close: () => built.close() };
}

/** Run a procedure and keep success and refusal apart, the way a face does: the
 *  stubs refuse several of these verbs, and a refusal is still proof the port
 *  was reached with a caller. */
function settle<A>(
  effect: Effect.Effect<A, unknown>,
): Promise<{ _tag: "Success" } | { _tag: "Failure" }> {
  return Effect.runPromise(Effect.result(effect)).then((outcome) => ({
    _tag: outcome._tag,
  }));
}

/** The field, only when the caller sent one — an explicit `undefined` would be
 *  the same as absent on the wire, but spelling it would hide which reading a
 *  case is stating. */
function sent(hostsFile: string | undefined): { hostsFile?: string } {
  return hostsFile === undefined ? {} : { hostsFile };
}

const READINGS: readonly {
  label: string;
  hostsFile: string | undefined;
  expected: Caller;
}[] = [
  {
    label: "a path names a fleet",
    hostsFile: "/fleets/a.json",
    expected: { hostsFile: "/fleets/a.json" },
  },
  {
    label: "an empty string is a shell with no $ODU_HOSTS",
    hostsFile: "",
    expected: { hostsFile: "" },
  },
  {
    label: "an absent field is a caller with no shell",
    hostsFile: undefined,
    expected: { hostsFile: null },
  },
];

describe("the caller is assembled once per call", () => {
  for (const reading of READINGS) {
    it(`carries ${reading.label} to every port`, async () => {
      const ports = recordingPorts();
      const { face, close } = serve(ports);
      try {
        const field = sent(reading.hostsFile);
        const [start, probe, hold, release, protect] = await Promise.all([
          settle(
            face.surface.run.start({
              checkout: CHECKOUT,
              expectedSha: HEAD,
              requestId: "caller-start-1",
              ...field,
            }),
          ),
          settle(face.surface.venue.probe({ platforms: [], ...field })),
          settle(
            face.surface.venue.hold({
              checkout: CHECKOUT,
              platforms: [PLATFORM],
              requestId: "caller-hold-1",
              ...field,
            }),
          ),
          settle(
            face.surface.venue.release({
              checkout: CHECKOUT,
              platforms: [],
              requestId: "caller-release-1",
              ...field,
            }),
          ),
          settle(
            face.surface.protect.apply({
              checkout: CHECKOUT,
              platforms: [PLATFORM],
              dryRun: true,
              requestId: "caller-protect-1",
              ...field,
            }),
          ),
        ]);
        // The verbs are allowed to refuse — a stub holds nothing and writes no
        // ruleset — but each must have REACHED its port with the caller.
        expect([start, probe, hold, release, protect].map((r) => r._tag)).toEqual([
          "Success",
          "Failure",
          "Failure",
          "Success",
          "Failure",
        ]);
        expect(ports.launches[0]?.caller).toEqual(reading.expected);
        expect(ports.probes[0]?.caller).toEqual(reading.expected);
        expect(ports.holds[0]?.caller).toEqual(reading.expected);
        expect(ports.releases[0]?.caller).toEqual(reading.expected);
        expect(ports.protects[0]?.caller).toEqual(reading.expected);
      } finally {
        await close();
      }
    });
  }
});
