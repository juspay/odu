/**
 * The Worker's cache and auth handlers, driven by the REAL Nix client: the
 * coordinator's `publishToLaneCache` uploads (signed, zstd, netrc Basic auth)
 * into an in-memory bucket behind `nixCache`, and `nix store cat` reads the
 * file back through the same handler, signature checked — the round trip a
 * cold container makes against R2, minus Cloudflare.
 */

import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { publishToLaneCache } from "@odu/execution/coordinator/cloudflare/laneCache";
import { captureProcess } from "@odu/execution/coordinator/runnerFlake";
import { authorized, type CacheBucket, nixCache, purgeCache } from "./http";

const SECRET = "lane-secret-0123456789abcdef";

function memoryBucket(): CacheBucket & { objects: Map<string, { bytes: Uint8Array; contentType: string }> } {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    objects,
    async get(key) {
      const o = objects.get(key);
      if (o === undefined) return null;
      return { body: new Blob([o.bytes as Uint8Array<ArrayBuffer>]).stream(), size: o.bytes.byteLength, httpMetadata: { contentType: o.contentType } };
    },
    async head(key) {
      const o = objects.get(key);
      return o === undefined ? null : { size: o.bytes.byteLength };
    },
    async list({ limit }) {
      return { objects: [...objects.keys()].slice(0, limit).map((key) => ({ key })), truncated: objects.size > limit };
    },
    async delete(keys) {
      for (const key of keys) objects.delete(key);
    },
    async put(key, body, options) {
      const bytes = new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
      objects.set(key, { bytes, contentType: options.httpMetadata.contentType });
    },
  };
}

describe("authorized", () => {
  const req = (authorization: string) => new Request("https://w.example/", { headers: { authorization } });
  it("accepts the bearer and netrc's Basic, nothing else", () => {
    expect(authorized(req(`Bearer ${SECRET}`), SECRET)).toBe(true);
    expect(authorized(req(`Basic ${btoa(`odu:${SECRET}`)}`), SECRET)).toBe(true);
    expect(authorized(req(`Bearer ${SECRET}x`), SECRET)).toBe(false);
    expect(authorized(req(`Basic ${btoa("odu:nope")}`), SECRET)).toBe(false);
    expect(authorized(req("Basic !!!"), SECRET)).toBe(false);
    expect(authorized(new Request("https://w.example/"), SECRET)).toBe(false);
  });
});

describe("nixCache", () => {
  it("refuses traversal and unknown methods, and says so when no bucket is bound", async () => {
    const bucket = memoryBucket();
    expect((await nixCache(new Request("https://w/x"), bucket, "../etc")).status).toBe(400);
    expect((await nixCache(new Request("https://w/x", { method: "DELETE" }), bucket, "a.narinfo")).status).toBe(405);
    expect((await nixCache(new Request("https://w/x"), undefined, "a.narinfo")).status).toBe(503);
    expect(await (await nixCache(new Request("https://w/x"), bucket, "nix-cache-info")).text()).toContain("StoreDir: /nix/store");
  });

  describe("round trip through the real Nix client", () => {
    const bucket = memoryBucket();
    let server: ReturnType<typeof Bun.serve>;
    let dir: string;
    let storePath: string;
    let url: string;
    let publicKey: string;

    beforeAll(() => {
      server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          if (!authorized(request, SECRET)) return new Response("unauthorized\n", { status: 401 });
          const path = new URL(request.url).pathname;
          return nixCache(request, bucket, path.slice("/nix-cache/".length));
        },
      });
      url = `http://127.0.0.1:${server.port}/nix-cache`;
      dir = mkdtempSync(join(tmpdir(), "odu-lane-cache-"));
      const nix = (args: string[], input?: string) =>
        execFileSync("nix", ["--extra-experimental-features", "nix-command", ...args], { encoding: "utf-8", input }).trim();
      writeFileSync(join(dir, "key.sec"), nix(["key", "generate-secret", "--key-name", "odu-lane-test-1"]));
      publicKey = nix(["key", "convert-secret-to-public"], readFileSync(join(dir, "key.sec"), "utf-8"));
      writeFileSync(join(dir, "netrc"), `machine 127.0.0.1 login odu password ${SECRET}\n`);
      writeFileSync(join(dir, "payload.txt"), `odu lane cache test ${Date.now()}\n`);
      storePath = nix(["store", "add-file", join(dir, "payload.txt")]);
    });
    afterAll(() => server.stop(true));

    it("uploads a signed closure and serves it back", async () => {
      await publishToLaneCache({
        outPath: storePath,
        cache: { url, secretKeyFile: join(dir, "key.sec"), publicKey, netrcFile: join(dir, "netrc"), awsCredentialsFile: null },
        onProgress: () => {},
        signal: new AbortController().signal,
      });
      const hash = storePath.slice("/nix/store/".length, "/nix/store/".length + 32);
      expect([...bucket.objects.keys()]).toContain(`${hash}.narinfo`);
      const narinfo = new TextDecoder().decode(bucket.objects.get(`${hash}.narinfo`)!.bytes);
      expect(narinfo).toContain("Compression: zstd");
      expect(narinfo).toContain("Sig: odu-lane-test-1:");

      // Read it back the way a container substitutes: netrc auth, signature
      // checked against the trusted key, NAR fetched and decompressed.
      // Async: the server answering it runs on this same event loop.
      const { stdout: back } = await captureProcess(
        "nix",
        [
          "--extra-experimental-features", "nix-command",
          "store", "cat", "--store", `${url}?trusted=0`,
          "--option", "netrc-file", join(dir, "netrc"),
          "--option", "trusted-public-keys", publicKey,
          storePath,
        ],
      );
      expect(back).toContain("odu lane cache test");

      // Teardown's purge empties it.
      expect(await (await purgeCache(bucket)).json()).toMatchObject({ more: false });
      expect(bucket.objects.size).toBe(0);
    }, 60_000);
  });
});

describe("container env", () => {
  it("ships the bridge under Cloudflare's 16,000-byte env var limit", () => {
    // worker.ts sends bridge.ts gzip'd + base64'd as ODU_LANE_BRIDGE_GZ.
    const source = readFileSync(new URL("./bridge.ts", import.meta.url));
    const encoded = Buffer.from(gzipSync(source)).toString("base64");
    expect(encoded.length).toBeLessThan(16_000 * 0.75); // headroom to grow
  });
});
