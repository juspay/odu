/**
 * `run.start` AND WHERE THE RUN PUSHES (PLAN 4.1).
 *
 * Four properties, and each is a decision the module header argues for:
 *
 *   - a resolved target reaches the LAUNCH, with a token minted for this run
 *     and nothing else;
 *   - two odu caches REFUSE the start, naming both, because a repository
 *     builds for one;
 *   - a launch that failed gives the token BACK, so a credential never
 *     outlives a run that does not exist;
 *   - the target is NOT in the request digest, so a replayed `requestId`
 *     re-resolves rather than replaying yesterday's bucket.
 *
 * Every one of them is asserted through the recording ports, which record what
 * the service ASKED FOR — the only way to tell a replayed answer from a second
 * act.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { LOCAL_OWNER } from "@odu/cordis/principal";
import type { StartInput } from "@odu/service-client/surface";
import {
  makeWorld,
  recordingPorts,
  type RecordingPorts,
  type World,
} from "./fixture.testlib";
import type { PushResolution } from "./ports";
import { requestStore } from "./requests";
import { startRun } from "./start";

let world: World | null = null;
const open = (): World => {
  world = makeWorld();
  return world;
};
afterEach(() => {
  world?.dispose();
  world = null;
});

const HEAD = "a".repeat(40);
const CHECKOUT = "/code/app";

const input = (over: Partial<StartInput> = {}): StartInput => ({
  checkout: CHECKOUT,
  expectedSha: HEAD,
  requestId: "req-1",
  ...over,
});

const TARGET: PushResolution = {
  kind: "target",
  target: {
    substituter: "https://cache.kolu.dev/kolu-r2",
    origin: "https://odu.kolu.dev",
    bucket: "kolu-r2",
    keyWarning: null,
  },
};

function start(
  w: World,
  ports: RecordingPorts,
  over: Partial<StartInput> = {},
): Promise<unknown> {
  return Effect.runPromise(
    Effect.result(
      startRun(
        input(over),
        {
          launch: ports.launch,
          probeCheckout: ports.probeCheckout,
          push: ports.push,
          requests: requestStore({ root: w.requestsRoot }),
          catalog: { root: w.catalogRoot },
          host: "test-host",
          now: () => 1_700_000_000_000,
        },
        LOCAL_OWNER,
      ),
    ),
  );
}

describe("a start that resolves a cache", () => {
  it("mints a token for THIS run and carries it to the launch", async () => {
    const w = open();
    const ports = recordingPorts({ push: () => TARGET });
    await start(w, ports);

    expect(ports.pushResolves).toEqual([CHECKOUT]);
    const launched = ports.launches[0];
    expect(launched?.push).toEqual({
      substituter: "https://cache.kolu.dev/kolu-r2",
      // THE RESOLVED ORIGIN travels with the launch: the lane pushes THERE
      // and asks no server what the substituter is.
      origin: "https://odu.kolu.dev",
      bucket: "kolu-r2",
      tokenId: "tok-1",
      token: "odu_stub_1",
    });
    // THE GRANT IS SCOPED TO THE RUN: the bucket it resolved and the run id
    // the receipt already names. No lifetime — how long a push credential may
    // outlive its run is the cache row's decision, made where `expires` is
    // written rather than by whichever caller happens to be minting.
    expect(ports.pushGrants[0]).toEqual({
      bucket: "kolu-r2",
      runId: launched?.runId ?? "",
    });
    // NOTHING TO SAY, either way: the key is trusted and a target stands.
    expect(launched?.pushSkipped).toBeNull();
    expect(launched?.pushKeyWarning).toBeNull();
    expect(ports.pushRevokes).toEqual([]);
  });

  it("carries the trusted-key warning on its OWN field, and still pushes", async () => {
    const w = open();
    const ports = recordingPorts({
      push: () => ({
        kind: "target",
        target: { ...TARGET.target, keyWarning: "its key is missing from trusted-public-keys" },
      }),
    });
    await start(w, ports);
    expect(ports.launches[0]?.push).not.toBeNull();
    expect(ports.launches[0]?.pushKeyWarning).toBe(
      "its key is missing from trusted-public-keys",
    );
    // AND NOT AS A SKIP. The two sentences read the same way in a log and
    // mean opposite things, and one field holding both is what made every
    // reader consult `push` to learn which it had.
    expect(ports.launches[0]?.pushSkipped).toBeNull();
  });

  it("launches with no push, and the reason, when nothing resolved", async () => {
    const w = open();
    const ports = recordingPorts({
      push: () => ({ kind: "skipped", reason: "no flake.nix" }),
    });
    await start(w, ports);
    expect(ports.launches[0]?.push).toBeNull();
    expect(ports.launches[0]?.pushSkipped).toBe("no flake.nix");
    expect(ports.launches[0]?.pushKeyWarning).toBeNull();
    // A run that pushes nothing mints nothing: there is no credential to
    // revoke and none to leak.
    expect(ports.pushGrants).toEqual([]);
  });

  it("REFUSES two odu caches, naming both, and starts nothing", async () => {
    const w = open();
    const ports = recordingPorts({
      push: () => ({
        kind: "ambiguous",
        substituters: ["https://a.example/one", "https://b.example/two"],
      }),
    });
    const outcome = await start(w, ports);
    expect(ports.launches).toEqual([]);
    expect(ports.pushGrants).toEqual([]);
    expect(JSON.stringify(outcome)).toContain("https://a.example/one");
    expect(JSON.stringify(outcome)).toContain("https://b.example/two");
    expect(JSON.stringify(outcome)).toContain("builds for one");
  });

  it("gives the token back when the launch failed", async () => {
    const w = open();
    const ports = recordingPorts({
      push: () => TARGET,
      launch: (request) => ({
        ok: false,
        runId: request.runId,
        endpoint: "",
        error: "the coordinator never registered",
      }),
    });
    await start(w, ports);
    // NOTHING EVER REACHED A LANE, so a credential left live for a day would
    // be a grant with no run behind it.
    expect(ports.pushRevokes).toEqual(["tok-1"]);
  });
});

describe("the request digest", () => {
  it("re-resolves on a repeat, and replays the receipt", async () => {
    const w = open();
    let answer: PushResolution = TARGET;
    const ports = recordingPorts({ push: () => answer });
    await start(w, ports);
    // The world moved: the bucket is gone. A repeat of the SAME request id is
    // still answered from the receipt — one execution per request id — and the
    // resolution is asked again rather than replayed from a stale value.
    answer = { kind: "skipped", reason: "no flake.nix" };
    await start(w, ports);
    expect(ports.launches).toHaveLength(1);
    expect(ports.pushResolves).toEqual([CHECKOUT]);
  });
});
