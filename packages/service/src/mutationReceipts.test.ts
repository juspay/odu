import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { buildSurfaceFace } from "@kolu/surface/client";
import { directDispatch } from "@kolu/surface/links/direct";
import {
  oduServiceSurface,
  type OduServiceClient,
  ServiceRefused,
  CI_CONTRACT_VERSION,
  CI_ROW,
} from "@odu/service-client/surface";
import { createOduService } from "./service";
import {
  makeWorld,
  recordingPorts,
  type RecordingPorts,
  type World,
} from "./fixture.testlib";

let world: World | null = null;
const open = (): World => {
  world = makeWorld();
  return world;
};
afterEach(() => {
  world?.dispose();
  world = null;
});

const CHECKOUT = "/code/app";
const PLATFORM = "x86_64-linux";

function serve(ports: RecordingPorts): {
  service: OduServiceClient;
  ports: RecordingPorts;
  close: () => Promise<void>;
} {
  const w = world ?? open();
  const built = createOduService({
    ports,
    origin: "http://127.0.0.1:0",
    home: w.requestsRoot,
    build: { oduVersion: "0.1.0", buildId: "test", commit: "", self: null },
    rows: { [CI_ROW]: CI_CONTRACT_VERSION },
    catalog: { root: w.catalogRoot },
    requestsRoot: w.requestsRoot,
    onDrain: () => {},
  });
  const face = buildSurfaceFace(
    oduServiceSurface,
    directDispatch(built.runtime),
  ) as unknown as OduServiceClient;
  return { service: face, ports, close: () => built.close() };
}

async function call<A>(
  effect: Effect.Effect<A, unknown>,
): Promise<{ ok: true; value: A } | { ok: false; code: string; message: string }> {
  const outcome = await Effect.runPromise(Effect.result(effect));
  if (outcome._tag === "Success") return { ok: true, value: outcome.success };
  const failure = outcome.failure;
  return failure instanceof ServiceRefused
    ? { ok: false, code: failure.code, message: failure.message }
    : { ok: false, code: "(not a refusal)", message: String(failure) };
}

describe("venue.release happens once", () => {
  it("replays the recorded answer instead of releasing a successor's hold", async () => {
    open();
    const { service, ports } = serve(
      recordingPorts({
        release: () => ({
          results: [
            {
              platform: PLATFORM,
              effective: "released" as const,
              host: "builder-1",
              detail: null,
            },
          ],
        }),
      }),
    );
    const request = {
      checkout: CHECKOUT,
      platforms: [PLATFORM],
      requestId: "client-a-release-1",
    };

    // THE SCENARIO, in order: A releases and the answer is recorded; the reply
    // is lost on the way back; somebody else takes a new hold; A retries.
    const first = await call(service.surface.venue.release(request));
    expect(first.ok).toBe(true);
    expect(ports.releases).toHaveLength(1);

    const again = await call(service.surface.venue.release(request));

    expect(again.ok).toBe(true);
    expect(ports.releases).toHaveLength(1);
    if (again.ok && first.ok) {
      expect(again.value.released).toEqual(first.value.released);
      expect(again.value.replayed).toBe(true);
      expect(first.value.replayed).toBe(false);
    }
  });

  it("refuses the same id used for a different request", async () => {
    open();
    const { service, ports } = serve(recordingPorts());

    await call(
      service.surface.venue.release({
        checkout: CHECKOUT,
        platforms: [PLATFORM],
        requestId: "reused",
      }),
    );
    const other = await call(
      service.surface.venue.release({
        checkout: CHECKOUT,
        platforms: ["aarch64-darwin"],
        requestId: "reused",
      }),
    );

    expect(other.ok).toBe(false);
    if (!other.ok) {
      expect(other.code).toBe("request_conflict");
      expect(other.message).toContain("reused");
    }
    expect(ports.releases).toHaveLength(1);
  });
});

describe("venue.hold happens once", () => {
  it("replays rather than taking a second hold", async () => {
    open();
    const { service, ports } = serve(
      recordingPorts({
        hold: () => ({
          ok: true as const,
          results: [
            {
              platform: PLATFORM,
              status: "held" as const,
              host: "builder-1",
              holderPid: 4242,
              waitingBehind: null,
              message: "held",
            },
          ],
        }),
      }),
    );
    const request = {
      checkout: CHECKOUT,
      platforms: [PLATFORM],
      requestId: "client-a-hold-1",
    };

    const first = await call(service.surface.venue.hold(request));
    const again = await call(service.surface.venue.hold(request));

    expect(first.ok).toBe(true);
    expect(again.ok).toBe(true);
    expect(ports.holds).toHaveLength(1);
    if (again.ok) expect(again.value.replayed).toBe(true);
  });
});

describe("protect.apply happens once", () => {
  it("replays rather than overwriting an intervening edit", async () => {
    open();
    let writes = 0;
    const { service, ports } = serve(
      recordingPorts({
        protect: () => {
          writes += 1;
          return {
            ok: true as const,
            facts: {
              repo: "juspay/odu",
              branch: "master",
              contexts: ["unit@x86_64-linux"],
              rulesetId: 7,
              applied: true,
              created: false,
              derivedFrom: null,
              detail: null,
            },
          };
        },
      }),
    );
    const request = {
      checkout: CHECKOUT,
      platforms: [PLATFORM],
      requestId: "protect-1",
    };

    const first = await call(service.surface.protect.apply(request));
    const again = await call(service.surface.protect.apply(request));

    expect(first.ok).toBe(true);
    expect(again.ok).toBe(true);
    expect(writes).toBe(1);
    expect(ports.protects).toHaveLength(1);
  });

  it("puts no receipt in a DRY RUN's way", async () => {
    open();
    const { service, ports } = serve(
      recordingPorts({
        protect: () => ({
          ok: true as const,
          facts: {
            repo: null,
            branch: null,
            contexts: ["unit@x86_64-linux"],
            rulesetId: null,
            applied: false,
            created: false,
            derivedFrom: null,
            detail: null,
          },
        }),
      }),
    );
    const request = {
      checkout: CHECKOUT,
      platforms: [PLATFORM],
      dryRun: true,
      requestId: "preview-1",
    };

    const first = await call(service.surface.protect.apply(request));
    const again = await call(service.surface.protect.apply(request));

    expect(first.ok).toBe(true);
    expect(again.ok).toBe(true);
    expect(ports.protects).toHaveLength(2);
  });
});

describe("a receipt knows which inventory it was for", () => {
  const HOLD = () => ({
    ok: true as const,
    results: [
      {
        platform: PLATFORM,
        status: "held" as const,
        host: "builder-1",
        holderPid: 4242,
        waitingBehind: null,
        message: "held",
      },
    ],
  });

  it("refuses an omitted override repeated as an explicit empty one", async () => {
    open();
    const { service, ports } = serve(recordingPorts({ hold: HOLD }));
    const base = { checkout: CHECKOUT, platforms: [PLATFORM], requestId: "fleet-1" };

    const first = await call(service.surface.venue.hold(base));
    const other = await call(
      service.surface.venue.hold({ ...base, hostsFile: "" }),
    );

    expect(first.ok).toBe(true);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe("request_conflict");
    expect(ports.holds).toHaveLength(1);
    expect(ports.holds[0]?.caller.hostsFile).toBeNull();
  });

  it("refuses two different explicit inventories under one id", async () => {
    open();
    const { service, ports } = serve(recordingPorts({ hold: HOLD }));
    const base = { checkout: CHECKOUT, platforms: [PLATFORM], requestId: "fleet-2" };

    await call(service.surface.venue.hold({ ...base, hostsFile: "/fleets/a.json" }));
    const other = await call(
      service.surface.venue.hold({ ...base, hostsFile: "/fleets/b.json" }),
    );

    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe("request_conflict");
    expect(ports.holds).toHaveLength(1);
    expect(ports.holds[0]?.caller.hostsFile).toBe("/fleets/a.json");
  });

  it("still replays the SAME inventory, however it was spelled", async () => {
    open();
    const { service, ports } = serve(recordingPorts({ hold: HOLD }));
    const request = {
      checkout: CHECKOUT,
      platforms: [PLATFORM],
      requestId: "fleet-3",
      hostsFile: "",
    };

    const first = await call(service.surface.venue.hold(request));
    const again = await call(service.surface.venue.hold(request));

    expect(first.ok).toBe(true);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.replayed).toBe(true);
    expect(ports.holds).toHaveLength(1);
    expect(ports.holds[0]?.caller.hostsFile).toBe("");
  });

  it("keeps the distinction ACROSS A RESTART, because the receipt is on disk", async () => {
    const w = open();
    const first = serve(recordingPorts({ hold: HOLD }));
    const base = { checkout: CHECKOUT, platforms: [PLATFORM], requestId: "fleet-4" };
    expect((await call(first.service.surface.venue.hold(base))).ok).toBe(true);
    await first.close();

    // A receipt outlives the service that wrote it — that is the whole reason
    // it is a file — so the digest has to survive the trip too. A daemon that
    // was restarted between a lost reply and its retry is exactly when a caller
    // repeats an id, and it must not be the moment the distinction is lost.
    expect(w.requestsRoot).not.toBe("");
    const second = serve(recordingPorts({ hold: HOLD }));
    const other = await call(
      second.service.surface.venue.hold({ ...base, hostsFile: "" }),
    );

    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe("request_conflict");
    expect(second.ports.holds).toHaveLength(0);
    await second.close();
  });

  it("refuses a protect repeated against a different inventory", async () => {
    open();
    const { service, ports } = serve(
      recordingPorts({
        protect: () => ({
          ok: true as const,
          facts: {
            repo: "juspay/odu",
            branch: "master",
            contexts: ["unit@x86_64-linux"],
            rulesetId: 7,
            applied: true,
            created: false,
            derivedFrom: null,
            detail: null,
          },
        }),
      }),
    );
    const base = {
      checkout: CHECKOUT,
      platforms: [PLATFORM],
      requestId: "protect-fleet",
    };

    await call(service.surface.protect.apply(base));
    const other = await call(
      service.surface.protect.apply({ ...base, hostsFile: "" }),
    );

    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe("request_conflict");
    expect(ports.protects).toHaveLength(1);
  });

  it("refuses a release repeated against a different inventory", async () => {
    open();
    const { service, ports } = serve(recordingPorts());
    const base = {
      checkout: CHECKOUT,
      platforms: [PLATFORM],
      requestId: "release-fleet",
    };

    await call(service.surface.venue.release(base));
    const other = await call(
      service.surface.venue.release({ ...base, hostsFile: "" }),
    );

    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe("request_conflict");
    expect(ports.releases).toHaveLength(1);
  });
});
