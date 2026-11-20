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
import { actorOf, LOCAL_ACTOR, type Caller } from "./caller";
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

function asked<A>(effect: Effect.Effect<A, unknown>): Promise<unknown> {
  return Effect.runPromise(Effect.result(effect));
}

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
      expect(ports.launches).toHaveLength(1);
    } finally {
      await close();
    }
  });
});

describe("the actor a run is recorded with", () => {
  it("is a signed-in person's login, and a RESERVED word for the machine's own owner", () => {
    expect(actorOf({ kind: "user", login: "srid", role: "member" })).toBe("srid");
    expect(actorOf({ kind: "user", login: "octo", role: "owner" })).toBe("octo");
    expect(actorOf(LOCAL_OWNER)).toBe(LOCAL_ACTOR);
    expect(LOCAL_ACTOR).toContain("@");
  });

  it("comes from the CONNECTION on a start, never from the input", async () => {
    const signedIn: Principal = { kind: "user", login: "srid", role: "member" };
    const ports = recordingPorts();
    const { face, close } = serve(ports, signedIn);
    try {
      await asked(
        face.surface.run.start({
          checkout: CHECKOUT,
          expectedSha: HEAD,
          requestId: "caller-start-actor",
        }),
      );
      const carried = ports.launches[0]?.caller.principal;
      expect(carried).toEqual(signedIn);
      expect(actorOf(carried ?? LOCAL_OWNER)).toBe("srid");
    } finally {
      await close();
    }
  });
});
