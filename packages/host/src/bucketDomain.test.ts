/**
 * A BUCKET'S NAME SERVES ONLY THE BUCKET.
 *
 * A tunnel forwards every path of a bucket's hostname to the daemon. The gate
 * that chooses what may answer there reads the cache row's facts: `/` is the
 * bucket's page, the row's claimed paths pass through, another bucket's path is
 * the row's 404, and the board, `/mcp`, `/auth` and `/rpc/ws` never answer.
 */

import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { BucketDomains } from "@odu/cordis/services";
import { bucketDomainGate } from "./bucketDomain";

/** The paths the cache row claims, spelled as the row spells them. */
const PATHS = [
  "/cache/*",
  "/_odu/v1/*",
  "/nix-cache-info",
  "/nar/*",
  "~^/[0-9abcdfghijklmnpqrsvwxyz]{32}\\.narinfo$",
];

/** The row's grammar, as its fact carries it — the gate under test reads THIS,
 *  not a private copy; the grammar itself is `@odu/cache`'s `bucketOf` test. */
const bucketOf = (path: string): string | null => {
  for (const prefix of ["/cache/", "/_odu/v1/buckets/"]) {
    if (!path.startsWith(prefix)) continue;
    const named = path.slice(prefix.length).split("/")[0] ?? "";
    return named === "" ? null : decodeURIComponent(named);
  }
  return null;
};

const domains: BucketDomains = {
  current: () => [{ bucket: "kolu", domain: "cache.example.org" }],
  subscribe: () => () => {},
  paths: PATHS,
  bucketOf,
};

const request = (host: string, url: string): HttpServerRequest.HttpServerRequest =>
  HttpServerRequest.fromWeb(
    new Request(`http://${host}${url}`, { headers: { host } }),
  );

/** The app reports the URL it was finally asked for — which is how a rewrite is
 *  told from a pass-through. */
const app = Effect.map(HttpServerRequest.HttpServerRequest, (incoming) =>
  HttpServerResponse.text(`app:${incoming.url}`),
);

async function through(host: string, url: string): Promise<{ status: number; body: string }> {
  const response = await Effect.runPromise(
    Effect.provideService(
      bucketDomainGate(() => domains)(app),
      HttpServerRequest.HttpServerRequest,
      request(host, url),
    ),
  );
  const web = HttpServerResponse.toWeb(response);
  return { status: web.status, body: await web.text() };
}

describe("a bucket's own name", () => {
  it("serves the bucket's page at /, and nothing of the daemon beside it", async () => {
    expect(await through("cache.example.org", "/")).toEqual({
      status: 200,
      body: "app:/cache/kolu",
    });
    // The protocol the name exists for.
    for (const path of [
      "/nix-cache-info",
      "/nar/abc.nar.zst",
      `/${"a".repeat(32)}.narinfo`,
      "/cache/kolu/nar/abc.nar.zst",
      "/_odu/v1/buckets/kolu/missing",
    ]) {
      expect({ path, ...(await through("cache.example.org", path)) }).toEqual({
        path,
        status: 200,
        body: `app:${path}`,
      });
    }
    // Everything else is the CACHE ROW'S 404 — the board, the door, the MCP
    // endpoint, the websocket, and another bucket's path forms.
    for (const path of [
      "/mcp",
      "/auth/github",
      "/rpc/ws",
      "/assets/app.js",
      "/",
      "/cache/other",
      "/cache/other/nar/abc.nar.zst",
      "/_odu/v1/buckets/other/missing",
    ].filter((one) => one !== "/")) {
      expect({ path, ...(await through("cache.example.org", path)) }).toEqual({
        path,
        status: 404,
        body: "no such cache path\n",
      });
    }
  });

  it("leaves a host that is not a bucket's alone", async () => {
    // The BOARD's host: the gate is not involved, and the shell and the door
    // answer as they always did.
    expect(await through("odu.example.org", "/")).toEqual({
      status: 200,
      body: "app:/",
    });
    expect(await through("odu.example.org", "/mcp")).toEqual({
      status: 200,
      body: "app:/mcp",
    });
    // A Host carries its port; the stored name does not.
    expect(await through("cache.example.org:443", "/")).toEqual({
      status: 200,
      body: "app:/cache/kolu",
    });
  });
});
