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
