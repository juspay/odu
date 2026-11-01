/**
 * THE GATE'S RESERVED SET COVERS EVERY ROUTE A ROW REGISTERS.
 *
 * A row's claim (`ClaimedRoutes.paths`) is written by hand beside its
 * `HttpRouter.add` calls, so it can still lag a new route in the same file.
 * This test builds each row's layer against a router that only RECORDS, and
 * asks the composed set about every path recorded — so a route outside its
 * row's claim fails here rather than as a sign-in page on a live pod (which is
 * how the cache's push API, `/_odu/v1/…`, was found).
 */

import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { authRoutes } from "@odu/auth/server";
import { cacheRoutes } from "@odu/cache/server";
import type { ClaimedRoutes, RowRoutes } from "@odu/cordis/services";
import { isReserved, reservedPaths } from "./reserved";

/** Every path a layer registers, read by building it against a recorder. No
 *  handler runs, so the rows' dependencies are never touched. */
async function registered(layer: RowRoutes): Promise<string[]> {
  const paths: string[] = [];
  const recorder = {
    add: (_method: string, path: string) => Effect.sync(() => void paths.push(path)),
    addAll: (routes: ReadonlyArray<{ readonly path: string }>) =>
      Effect.sync(() => void paths.push(...routes.map((route) => route.path))),
  } as unknown as HttpRouter.HttpRouter;
  // The layer's other requirements are phantom request markers for the
  // router's typing; the recorder satisfies the one it reads.
  const built = layer as unknown as Layer.Layer<never, never, HttpRouter.HttpRouter>;
  await Effect.runPromise(
    Effect.scoped(Layer.build(built)).pipe(
      Effect.provideService(HttpRouter.HttpRouter, recorder),
    ),
  );
  return paths;
}

/** A route pattern as a request would spell it. A plain `:param` is a value; a
 *  regex-constrained one is rendered into something its grammar accepts — the
 *  cache's `:hash(...)` takes a 32-character base32 hash, so a run of `a`s
 *  matches it. */
const concrete = (pattern: string): string =>
  pattern
    .replace(/:([A-Za-z][A-Za-z0-9]*)\([^)]*\)/g, (_match, name: string) =>
      name === "hash" ? "a".repeat(32) : "value",
    )
    .replace(/:[^/]+/g, "value");

// The handlers close over these and never run; only the layer's shape is read.
const ROWS: ReadonlyArray<readonly [string, ClaimedRoutes]> = [
  ["cache", cacheRoutes({} as Parameters<typeof cacheRoutes>[0])],
  [
    "auth",
    authRoutes({
      config: { publicOrigin: "https://odu.example" } as Parameters<
        typeof authRoutes
      >[0]["config"],
      server: {} as Parameters<typeof authRoutes>[0]["server"],
      log: { warn: () => {} },
    }),
  ],
];

describe("the door gate's reserved set", () => {
  const reserved = reservedPaths(ROWS.map(([, row]) => row));

  for (const [name, row] of ROWS) {
    it(`claims every route the ${name} row registers`, async () => {
      const paths = await registered(row.layer);
      expect(paths.length).toBeGreaterThan(0);
      const unclaimed = paths.filter((path) => !isReserved(concrete(path), reserved));
      expect(unclaimed).toEqual([]);
    });
  }

  it("claims the cache's push API — the route the hand-kept list forgot", () => {
    expect(isReserved("/_odu/v1/buckets/test/missing", reserved)).toBe(true);
  });

  it("claims a bucket domain's root-level protocol paths", () => {
    // A bucket's own name serves the Nix protocol at `/`. The narinfo claim is
    // a REGEX because its shape cannot be a prefix, and a prefix that took
    // every one-segment path would shadow the shell.
    for (const path of [
      "/nix-cache-info",
      "/nar/abc.nar.zst",
      `/${"a".repeat(32)}.narinfo`,
    ]) {
      expect({ path, claimed: isReserved(path, reserved) }).toEqual({ path, claimed: true });
    }
    // And the shape is not the whole one-segment space.
    expect(isReserved("/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.narinfo", reserved)).toBe(false);
  });

  it("answers an unmatched path under a claimed prefix as the row's own 404", async () => {
    // A CLAIM MEANS "MINE": the cache row registers a catch-all under each
    // path it claims, so a path that matches no protocol file is the cache's
    // text 404 — never the shell's SPA, which is what a bare `…/cache/kolu`
    // used to render. The shell here is the same `GET /*` the listener has.
    const cache = { bucket: () => null } as unknown as Parameters<typeof cacheRoutes>[0];
    const { handler } = HttpRouter.toWebHandler(
      Layer.merge(
        cacheRoutes(cache).layer,
        HttpRouter.add("GET", "/*", () =>
          Effect.succeed(HttpServerResponse.text("shell")),
        ),
      ),
      { disableLogger: true },
    );
    const get = (path: string): Promise<Response> =>
      handler(new Request(`http://127.0.0.1:18440${path}`));

    for (const path of [
      // An unknown bucket's page is the consumer route's own empty 404 …
      "/cache/nope",
      "/cache/nope/",
      // … and a path that matches no protocol file is the CATCH-ALL's sentence,
      // never the shell's HTML.
      "/cache/nope/deeper/still",
      "/nar/a/b",
      "/_odu/v1/nope",
    ]) {
      const response = await get(path);
      const body = await response.text();
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
      expect({ path, shell: body === "shell" }).toEqual({ path, shell: false });
      if (path.includes("deeper") || path.startsWith("/nar") || path.startsWith("/_odu")) {
        expect({ path, body }).toEqual({ path, body: "no such cache path\n" });
      }
    }
    // The shell keeps the paths that are the shell's.
    for (const path of ["/", "/nope", "/cache-not"]) {
      expect({ path, body: await (await get(path)).text() }).toEqual({
        path,
        body: "shell",
      });
    }
  });

  it("leaves everything unclaimed to the shell", () => {
    for (const path of ["/", "/runs", "/cache/", "/_odu/v1/", "/auth/", "/typo"]) {
      expect(isReserved(path, reserved)).toBe(false);
    }
  });
});
