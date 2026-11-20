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
          moveCheckout: ports.moveCheckout,
          cancel: ports.cancel,
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
      origin: "https://odu.kolu.dev",
      bucket: "kolu-r2",
      tokenId: "tok-1",
      token: "odu_stub_1",
    });
    expect(ports.pushGrants[0]).toEqual({
      bucket: "kolu-r2",
      runId: launched?.runId ?? "",
    });
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
    expect(ports.pushRevokes).toEqual(["tok-1"]);
  });
});

describe("the request digest", () => {
  it("re-resolves on a repeat, and replays the receipt", async () => {
    const w = open();
    let answer: PushResolution = TARGET;
    const ports = recordingPorts({ push: () => answer });
    await start(w, ports);
    answer = { kind: "skipped", reason: "no flake.nix" };
    await start(w, ports);
    expect(ports.launches).toHaveLength(1);
    expect(ports.pushResolves).toEqual([CHECKOUT]);
  });
});
