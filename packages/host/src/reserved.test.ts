import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { authRoutes } from "@odu/auth/server";
import { cacheRoutes } from "@odu/cache/server";
import type { ClaimedRoutes, RowRoutes } from "@odu/cordis/services";
import { METRICS_PATH } from "@odu/cordis/metricsSurface";
import { isReserved, reservedClaims } from "./reserved";

async function registered(layer: RowRoutes): Promise<string[]> {
  const paths: string[] = [];
  const recorder = {
    add: (_method: string, path: string) => Effect.sync(() => void paths.push(path)),
    addAll: (routes: ReadonlyArray<{ readonly path: string }>) =>
      Effect.sync(() => void paths.push(...routes.map((route) => route.path))),
  } as unknown as HttpRouter.HttpRouter;
  const built = layer as unknown as Layer.Layer<never, never, HttpRouter.HttpRouter>;
  await Effect.runPromise(
    Effect.scoped(Layer.build(built)).pipe(
      Effect.provideService(HttpRouter.HttpRouter, recorder),
    ),
  );
  return paths;
}

const concrete = (pattern: string): string =>
  pattern
    .replace(/:([A-Za-z][A-Za-z0-9]*)\([^)]*\)/g, (_match, name: string) =>
      name === "hash" ? "a".repeat(32) : "value",
    )
    .replace(/:[^/]+/g, "value");

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
  const reserved = reservedClaims(ROWS.map(([, row]) => row));

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

  it("reserves the host's own scrape, so a door never answers it with the sign-in page", () => {
    expect(isReserved(METRICS_PATH, reservedClaims([]))).toBe(true);
  });

  it("claims a bucket domain's root-level protocol paths", () => {
    for (const path of [
      "/nix-cache-info",
      "/nar/abc.nar.zst",
      `/${"a".repeat(32)}.narinfo`,
    ]) {
      expect({ path, claimed: isReserved(path, reserved) }).toEqual({ path, claimed: true });
    }
    expect(isReserved("/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.narinfo", reserved)).toBe(false);
  });

  it("answers an unmatched path under a claimed prefix as the row's own 404", async () => {
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
      "/cache/nope",
      "/cache/nope/",
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
