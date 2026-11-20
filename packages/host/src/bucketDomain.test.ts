import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { type BucketDomains, routeClaim } from "@odu/cordis/services";
import { bucketDomainGate } from "./bucketDomain";

const PATHS = [
  "/cache/*",
  "/_odu/v1/*",
  "/nix-cache-info",
  "/nar/*",
  "~^/[0-9abcdfghijklmnpqrsvwxyz]{32}\\.narinfo$",
].map(routeClaim);

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
    expect(await through("odu.example.org", "/")).toEqual({
      status: 200,
      body: "app:/",
    });
    expect(await through("odu.example.org", "/mcp")).toEqual({
      status: 200,
      body: "app:/mcp",
    });
    expect(await through("cache.example.org:443", "/")).toEqual({
      status: 200,
      body: "app:/cache/kolu",
    });
  });
});
