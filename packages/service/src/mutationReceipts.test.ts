/**
 * `venue.hold`, `venue.release` and `protect.apply` HAPPEN ONCE.
 *
 * These three carried a `requestId` and did nothing with it, on the reasoning
 * that they are naturally idempotent: taking a hold you already hold, dropping
 * one you already dropped, and writing a ruleset that already says what you
 * asked are all indistinguishable from doing it once.
 *
 * That is true of the OPERATION and false of the SERVICE, because the daemon is
 * shared and the resource has an identity:
 *
 * > A client releases platform P and its reply is lost. Another client takes a
 * > new hold on P. The first client retries its release — the same request, by
 * > its own reckoning — and drops somebody else's hold.
 *
 * The same shape lets a delayed `protect.apply` overwrite a ruleset that was
 * edited in between. Neither is a repeat of the original operation; both are a
 * NEW operation wearing an old request's name.
 *
 * Every test below asserts the same two things together: what the caller was
 * told, and whether the PORT was reached. The second is the one that matters —
 * a replayed answer and a second act are indistinguishable from the reply
 * alone, which is exactly why this was invisible.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { buildSurfaceFace } from "@kolu/surface/client";
import { directDispatch } from "@kolu/surface/links/direct";
import {
  oduServiceSurface,
  type OduServiceClient,
  ServiceRefused,
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

/**
 * A real service over recording ports, reached IN PROCESS.
 *
 * `directDispatch` over the runtime's own handler record — the framework's
 * in-process identity link. The point of going through the service rather than
 * calling `onceOnly` is that the receipt has to be in the DISPATCH: a helper
 * that is correct and unreferenced is exactly the state these three verbs were
 * already in.
 */
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

/** Run a procedure and keep the three outcomes apart, the way a face does. */
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
    // THE SCENARIO, in order: A releases and the answer is recorded; the reply
    // is lost on the way back; somebody else takes a new hold; A retries.
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

    const first = await call(service.surface.venue.release(request));
    expect(first.ok).toBe(true);
    expect(ports.releases).toHaveLength(1);

    // …the reply never arrived, and the world moved on. A retries verbatim.
    const again = await call(service.surface.venue.release(request));

    expect(again.ok).toBe(true);
    // THE ASSERTION: the port was not reached a second time. Whoever holds the
    // platform now still holds it.
    expect(ports.releases).toHaveLength(1);
    if (again.ok && first.ok) {
      // The SAME answer, plus the flag that says where it came from.
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
    // Dispatched nothing. The schema comment used to permit exactly this.
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
    // The repeat SAYS it is one. A caller that cannot tell a replay from a
    // fresh hold cannot tell whether its first attempt landed.
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
    // ONE write. A branch's merge policy is not a thing to set twice on the
    // strength of a reply that went missing.
    expect(writes).toBe(1);
    expect(ports.protects).toHaveLength(1);
  });

  it("puts no receipt in a DRY RUN's way", async () => {
    // A dry run writes nothing and contacts no forge, so it has no successor to
    // act on. Refusing the second `--dry-run` under one id would be a refusal
    // about nothing.
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

/**
 * WHICH FLEET, and why a receipt has to be able to tell.
 *
 * `hostsFile` reaches these three verbs with three readings — a PATH names a
 * file, `""` says the caller's shell had none (so resolution starts at
 * `~/.config`), ABSENT says nobody said, which is the only reading under which
 * the daemon's own `$ODU_HOSTS` answers. The ports keep all three apart
 * (`input.hostsFile ?? null`); the digests collapsed the first two into `""`.
 *
 * A digest is the ONLY thing standing between a replay and a conflict, so a
 * collapsed one is not a cosmetic loss: a caller that asked about fleet B under
 * an id it had used for fleet A was told, with `replayed: true`, that its
 * request had already succeeded — and handed A's answer, describing machines it
 * had not asked about. Every test below asserts the refusal AND that the port
 * was not reached, because "told about a conflict" and "quietly acted on"
 * differ only in the second.
 */
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
    // THE REPRODUCTION. Omitted means "use the daemon's `$ODU_HOSTS`"; `""`
    // means "bypass it". Two fleets, and the second call was being told it had
    // already run on the first.
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
    // The port saw the FIRST request and nothing else. A `replayed: true` here
    // would have been the answer to a question nobody asked.
    expect(ports.holds).toHaveLength(1);
    expect(ports.holds[0]?.hostsFile).toBeNull();
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
    expect(ports.holds[0]?.hostsFile).toBe("/fleets/a.json");
  });

  it("still replays the SAME inventory, however it was spelled", async () => {
    // The other half of the contract, and the one a too-eager fix breaks: a
    // genuine repeat is still a repeat. `""` twice is one request.
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
    expect(ports.holds[0]?.hostsFile).toBe("");
  });

  it("keeps the distinction ACROSS A RESTART, because the receipt is on disk", async () => {
    // A receipt outlives the service that wrote it — that is the whole reason
    // it is a file — so the digest has to survive the trip too. A daemon that
    // was restarted between a lost reply and its retry is exactly when a caller
    // repeats an id, and it must not be the moment the distinction is lost.
    const w = open();
    const first = serve(recordingPorts({ hold: HOLD }));
    const base = { checkout: CHECKOUT, platforms: [PLATFORM], requestId: "fleet-4" };
    expect((await call(first.service.surface.venue.hold(base))).ok).toBe(true);
    await first.close();

    // A NEW service over the same state root: same receipts, no memory.
    expect(w.requestsRoot).not.toBe("");
    const second = serve(recordingPorts({ hold: HOLD }));
    const other = await call(
      second.service.surface.venue.hold({ ...base, hostsFile: "" }),
    );

    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe("request_conflict");
    // And the restarted service performed nothing.
    expect(second.ports.holds).toHaveLength(0);
    await second.close();
  });

  it("refuses a protect repeated against a different inventory", async () => {
    // The same shape with a branch's merge policy as the resource. `protect`
    // resolves its contexts against the fleet it is given, so the same id
    // against a different one is a request to write a DIFFERENT ruleset.
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
    // Release carries the same field for the same reason, so it gets the same
    // answer. One shared mutation contract, not three that happen to agree.
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
