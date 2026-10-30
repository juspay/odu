/**
 * THE URL A BUCKET PUBLISHES, which is the one thing about the cache that a
 * proxy changes.
 *
 * A daemon behind nginx is bound to loopback; the address its clients must be
 * told is the proxy's, and `odu cache use` prints whatever this answers into a
 * `nix.conf`. So `create`/`list`/`describe` answer `publicOrigin` when it is
 * configured and the bound origin otherwise — and only those: the board, the
 * websocket and the identity cell stay on the address this process serves at,
 * because a process cannot be reached at an address it never bound.
 *
 * The cache's admin port is stubbed here on purpose: this suite is about the
 * SERVICE's one field, and the cache has its own wall with its own suite.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Stream } from "effect";
import { buildSurfaceFace } from "@kolu/surface/client";
import { directDispatch } from "@kolu/surface/links/direct";
import { type OduServiceClient, oduServiceSurface } from "@odu/service-client/surface";
import { makeWorld, recordingPorts, type World } from "./fixture.testlib";
import type { CacheAdmin, CacheBucketFacts } from "./ports";
import { createOduService } from "./service";

let world: World | null = null;
afterEach(() => {
  world?.dispose();
  world = null;
});

const BOUND = "http://127.0.0.1:18440";
const PUBLIC = "https://cache.example.com";

const bucket: CacheBucketFacts = {
  name: "main",
  public: true,
  retentionDays: 30,
  keyName: "main-1",
  publicKey: "main-1:AAAA",
  upstreamKeys: ["cache.nixos.org-1"],
  objects: 0,
  bytes: 0,
  created: 0,
};

const identity = { name: "main", public: true, publicKey: "main-1:AAAA" };

/** A cache port that answers one bucket and nothing else. */
function cachePort(): CacheAdmin {
  const facts = bucket;
  return {
    mount: "/cache",
    create: async () => ({ ok: true, value: facts }),
    list: async () => ({ ok: true, value: [facts] }),
    describe: async () => ({ ok: true, value: identity }),
    tokenMint: async () => ({ ok: false, code: "no_root_token", message: "stub" }),
    tokenList: async () => ({ ok: true, value: [] }),
    tokenRevoke: async () => ({ ok: false, code: "no_root_token", message: "stub" }),
    pin: async () => ({ ok: false, code: "no_root_token", message: "stub" }),
    gc: async () => ({ ok: false, code: "no_root_token", message: "stub" }),
    stats: async () => {
      throw new Error("not asked");
    },
  };
}

function serve(w: World, publicOrigin?: string) {
  const built = createOduService({
    ports: { ...recordingPorts(), cache: cachePort() },
    origin: BOUND,
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
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
  return { face, close: () => built.close() };
}

describe("the substituter URL a bucket publishes", () => {
  it("is the bound origin when nothing else is configured", async () => {
    world = makeWorld();
    const { face, close } = serve(world);
    expect((await Effect.runPromise(face.surface.cache.describe({ bucket: "main" }))).url).toBe(
      `${BOUND}/cache/main`,
    );
    const listed = await Effect.runPromise(face.surface.cache.list({ rootToken: "t" }));
    expect(listed.buckets[0]?.url).toBe(`${BOUND}/cache/main`);
    await close();
  });

  it("is the public origin when a proxy stands in front", async () => {
    world = makeWorld();
    const { face, close } = serve(world, PUBLIC);
    // The proof that matters: a reader puts this string into `nix.conf`, and a
    // loopback URL there is a substituter that works for nobody.
    expect((await Effect.runPromise(face.surface.cache.describe({ bucket: "main" }))).url).toBe(
      `${PUBLIC}/cache/main`,
    );
    const created = await Effect.runPromise(
      face.surface.cache.create({
        rootToken: "t",
        name: "main",
        public: true,
        retentionDays: 30,
        upstreamKeys: [],
      }),
    );
    expect(created.url).toBe(`${PUBLIC}/cache/main`);
    await close();
  });

  it("leaves the service's own identity on the address it is BOUND to", async () => {
    world = makeWorld();
    const { face, close } = serve(world, PUBLIC);
    // Nothing else moved: a process cannot be reached at an origin it never
    // bound, so the identity cell keeps answering the bound one.
    // A cell's `get` takes its (void) input explicitly — see `webLauncher.ts`.
    const cell = await Effect.runPromise(Stream.runHead(face.surface.service.get(undefined)));
    expect(cell._tag === "Some" ? cell.value.identity.origin : "(no frame)").toBe(BOUND);
    await close();
  });
});
