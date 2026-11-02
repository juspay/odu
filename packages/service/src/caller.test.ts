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
import { Effect, Stream } from "effect";
import { buildSurfaceFace } from "@kolu/surface/client";
import { directDispatch } from "@kolu/surface/links/direct";
import type { SurfaceDispatch } from "@kolu/surface/link";
import type { SurfaceHandlers } from "@kolu/surface/server";
import {
  CurrentPrincipal,
  LOCAL_OWNER,
  requestAdmission,
  type Principal,
} from "@odu/cordis/principal";
import {
  oduServiceSurface,
  type OduServiceClient,
  CI_CONTRACT_VERSION,
  CI_ROW,
} from "@odu/service-client/surface";
import type { Caller } from "./caller";
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

/** A dispatch that provides ONE principal to every handler — what the daemon's
 *  per-connection services do, spelled here so this suite can state the claim
 *  without importing the host. */
function dispatchedAs(handlers: SurfaceHandlers, principal: Principal): SurfaceDispatch {
  const base = directDispatch({ handlers });
  const admission = requestAdmission(principal);
  return {
    unary: (tag, payload) =>
      Effect.provideService(base.unary(tag, payload), CurrentPrincipal, admission),
    stream: (tag, payload) =>
      Stream.provideService(base.stream(tag, payload), CurrentPrincipal, admission),
  };
}

function serve(ports: RecordingPorts, principal?: Principal) {
  world = makeWorld();
  const built = createOduService({
    ports,
    origin: "http://127.0.0.1:0",
    home: world.requestsRoot,
    build: { oduVersion: "0.1.0", buildId: "test", commit: "", self: null },
    rows: { [CI_ROW]: CI_CONTRACT_VERSION },
    catalog: { root: world.catalogRoot },
    requestsRoot: world.requestsRoot,
    onDrain: () => {},
  });
  const face = buildSurfaceFace(
    oduServiceSurface,
    principal === undefined
      ? directDispatch(built.runtime)
      : dispatchedAs(built.runtime.handlers, principal),
  ) as unknown as OduServiceClient;
  return { face, close: () => built.close() };
}

/** A procedure whose outcome this suite does not care about — only that it
 *  reached its port. The stubs refuse several of these verbs on purpose, and a
 *  refusal is still proof the caller was carried there. */
function asked<A>(effect: Effect.Effect<A, unknown>): Promise<unknown> {
  return Effect.runPromise(Effect.result(effect));
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
    expected: { hostsFile: "/fleets/a.json", principal: LOCAL_OWNER },
  },
  {
    label: "an empty string is a shell with no $ODU_HOSTS",
    hostsFile: "",
    expected: { hostsFile: "", principal: LOCAL_OWNER },
  },
  {
    label: "an absent field is a caller with no shell",
    hostsFile: undefined,
    expected: { hostsFile: null, principal: LOCAL_OWNER },
  },
];

describe("the caller is assembled once per call", () => {
  for (const reading of READINGS) {
    it(`carries ${reading.label} to every port`, async () => {
      const ports = recordingPorts();
      const { face, close } = serve(ports);
      try {
        const field = sent(reading.hostsFile);
        await Promise.all([
          asked(
            face.surface.run.start({
              checkout: CHECKOUT,
              expectedSha: HEAD,
              requestId: "caller-start-1",
              ...field,
            }),
          ),
          asked(face.surface.venue.probe({ platforms: [], ...field })),
          asked(
            face.surface.venue.hold({
              checkout: CHECKOUT,
              platforms: [PLATFORM],
              requestId: "caller-hold-1",
              ...field,
            }),
          ),
          asked(
            face.surface.venue.release({
              checkout: CHECKOUT,
              platforms: [],
              requestId: "caller-release-1",
              ...field,
            }),
          ),
          asked(
            face.surface.protect.apply({
              checkout: CHECKOUT,
              platforms: [PLATFORM],
              dryRun: true,
              requestId: "caller-protect-1",
              ...field,
            }),
          ),
        ]);
        // THE claim: one recorded request per port, each carrying the caller.
        // What the stubs ANSWERED is their own business — asserting a pattern
        // of successes and refusals here would be testing the stubs.
        expect(ports.launches).toHaveLength(1);
        expect(ports.probes).toHaveLength(1);
        expect(ports.holds).toHaveLength(1);
        expect(ports.releases).toHaveLength(1);
        expect(ports.protects).toHaveLength(1);
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

  /**
   * THE OTHER HALF OF THE SAME CONTRACT: the principal is the CONNECTION's.
   *
   * Nothing on the wire can say who is asking — the verb inputs carry no such
   * field — so the only way a port learns it is from the context the call
   * arrived in. This provides one, and reads it back at the port that carries a
   * `Caller` furthest from the door (a venue HOLD, which is also a state change
   * and therefore the verb whose rule is "signed in").
   */
  it("carries the connection's principal to the ports, and takes none from input", async () => {
    const signedIn: Principal = { kind: "user", login: "srid", role: "member" };
    const ports = recordingPorts();
    const { face, close } = serve(ports, signedIn);
    try {
      await asked(
        face.surface.venue.hold({
          checkout: CHECKOUT,
          platforms: [PLATFORM],
          requestId: "caller-hold-principal",
        }),
      );
      expect(ports.holds[0]?.caller.principal).toEqual(signedIn);
    } finally {
      await close();
    }
  });

  /**
   * AND THE ROW'S RULE, SEEN FROM THE ROW: a signed-in MEMBER may start a run.
   * The refusal this asserts is the one an identity provider's lowest role must
   * NOT meet; a higher role is the next test's business.
   */
  it("lets a member change a run", async () => {
    const ports = recordingPorts();
    const { face, close } = serve(ports, { kind: "user", login: "srid", role: "member" });
    try {
      await asked(
        face.surface.run.start({
          checkout: CHECKOUT,
          expectedSha: HEAD,
          requestId: "caller-start-member",
        }),
      );
      // The port is the proof: a refusal never reaches it.
      expect(ports.launches).toHaveLength(1);
    } finally {
      await close();
    }
  });
});
