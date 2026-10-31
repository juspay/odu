/**
 * The push client, against a server in this process.
 *
 * Three properties, and each of them is a promise the docs make:
 *
 *   - **dependency order.** A closure is pushed shallowest first, so the server
 *     can import each path the moment its narinfo lands. Out of order, Nix says
 *     "is not valid" and a push of any real closure fails.
 *   - **retry per path.** A dropped upload is retried, and the retry does not
 *     re-send the paths that already landed.
 *   - **token precedence.** `--token-file`, then `$ODU_CACHE_TOKEN`, then the
 *     credentials file — in that order, and never the other way round, because
 *     CI sets the variable and a stale login must not win over it.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { narHashBase32, storePathHash } from "./narinfo";
import {
  credentialsPath,
  type ClosureEntry,
  formatPushNarinfo,
  pushToCache,
  resolveBucket,
  resolveToken,
  saveCredential,
  type PushEnv,
  type PushPlatform,
} from "./push";
import type { PathInfo } from "./store";

const HELLO = "/nix/store/pa6rydwgjxxmmvdxap7qk9c85h8jbimy-hello-2.12.3";
const GLIBC = "/nix/store/pqyiidz5mi73wv5f91d48s9plcqyj5bz-glibc-2.44-57";
const LIBC = "/nix/store/00fs4zz9c0jjcvs62wg39b91dydz7zqb-libidn2-2.3.8";

/** A distinct nar hash per path, so an upload's file name identifies its path —
 *  which is how the assertions below read the order off the wire. */
function entry(storePath: string, references: readonly string[] = []): ClosureEntry {
  return {
    storePath,
    narHash: `sha256:${storePathHash(storePath).padEnd(52, "0")}`,
    narSize: 10,
    references,
    deriver: null,
    sigs: [],
  };
}

/** hello → glibc → libidn2, so the depth order is libidn2, glibc, hello. */
const CLOSURE = new Map<string, ClosureEntry>([
  [HELLO, entry(HELLO, [GLIBC])],
  [GLIBC, entry(GLIBC, [LIBC])],
  [LIBC, entry(LIBC)],
]);

interface Seen {
  method: string;
  path: string;
  authorization: string | null;
  body: string;
}

interface Server {
  origin: string;
  seen: Seen[];
  /** How many times each path's nar upload should fail before succeeding. */
  failNar: Map<string, number>;
  /** Status to answer a nar upload with, before the failure count applies. */
  narStatus: Map<string, number>;
  /** Store paths whose narinfo answers 202 the first time it is asked. */
  deferOnce: Set<string>;
  /** Store paths whose narinfo answers 202 every time — a hold nobody fixes. */
  alwaysDefer: Set<string>;
  /** Parts received, keyed `${file}:${index}`. */
  parts: Map<string, string>;
  /** How many times a part answers 500 before succeeding, keyed the same. */
  partFailures: Map<string, number>;
  /** Every completed join, in order. */
  completed: { file: string; total: number }[];
  /** How many `/missing` calls still answer the current list; `undefined`
   *  means every call does. */
  missingCalls: number;
  missingOnlyFor: number | undefined;
  /** Answer a narinfo PUT that carries no preceding NAR with a 400 saying the
   *  bytes are gone — what a restarted server says. */
  narinfoOnlyRefusal: boolean;
  missing: string[];
  skipped: string[];
  stop: () => void;
}

function startServer(): Server {
  const state: Server = {
    origin: "",
    seen: [],
    failNar: new Map(),
    narStatus: new Map(),
    deferOnce: new Set(),
    alwaysDefer: new Set(),
    parts: new Map(),
    partFailures: new Map(),
    completed: [],
    missingCalls: 0,
    missingOnlyFor: undefined,
    narinfoOnlyRefusal: false,
    missing: [LIBC, GLIBC, HELLO],
    skipped: [],
    stop: () => {},
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "GET" ? "" : await request.text();
      state.seen.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        body,
      });
      if (url.pathname.endsWith("/missing")) {
        state.missingCalls += 1;
        if (state.missingOnlyFor !== undefined && state.missingCalls > state.missingOnlyFor) {
          return Response.json({ missing: [], skippedUpstream: [] });
        }
        return Response.json({ missing: state.missing, skippedUpstream: state.skipped });
      }
      if (request.method === "PUT" && url.pathname.includes("/parts/")) {
        const index = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
        const file = url.pathname.slice(url.pathname.lastIndexOf("/nar/") + 5, -`/parts/${index}`.length);
        const key = `${file}:${index}`;
        const failures = state.partFailures.get(key) ?? 0;
        if (failures > 0) {
          state.partFailures.set(key, failures - 1);
          return new Response("nope", { status: 500 });
        }
        state.parts.set(key, body);
        return new Response(null, { status: 204 });
      }
      if (request.method === "POST" && url.pathname.endsWith("/complete")) {
        const file = url.pathname.slice(url.pathname.lastIndexOf("/nar/") + 5, -"/complete".length);
        const total = Number(request.headers.get("x-odu-parts"));
        const missing: number[] = [];
        for (let index = 0; index < total; index++) {
          if (!state.parts.has(`${file}:${index}`)) missing.push(index);
        }
        if (missing.length > 0) return Response.json({ missing }, { status: 409 });
        state.completed.push({ file, total });
        return Response.json({ parts: total });
      }
      if (request.method === "PUT" && url.pathname.includes("/nar/")) {
        const file = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
        const forced = state.narStatus.get(file);
        if (forced !== undefined) return new Response("nope", { status: forced });
        const failures = state.failNar.get(file) ?? 0;
        if (failures > 0) {
          state.failNar.set(file, failures - 1);
          return new Response("nope", { status: 500 });
        }
        return new Response(null, { status: 200 });
      }
      if (request.method === "PUT" && url.pathname.endsWith(".narinfo")) {
        const hash = url.pathname.slice(url.pathname.lastIndexOf("/") + 1, -".narinfo".length);
        if (state.alwaysDefer.has(hash) || state.deferOnce.delete(hash)) {
          return new Response(
            `waiting for 1 reference that is neither here nor upstream: ${GLIBC}`,
            { status: 202 },
          );
        }
        if (state.narinfoOnlyRefusal) {
          state.narinfoOnlyRefusal = false;
          return new Response("the narinfo names nar/x.nar.zst, which was never uploaded", {
            status: 400,
          });
        }
        return new Response(null, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  state.origin = `http://127.0.0.1:${server.port}`;
  state.stop = () => server.stop(true);
  return state;
}

/** Every store path is given the same nar hash above, which the fake server
 *  keys on — so the failure counts are per PATH here rather than per file. */
const PLATFORM: PushPlatform = {
  closure: async () => [...CLOSURE.values()] as PathInfo[],
  dump: () => new ReadableStream({ start: (controller) => controller.close() }),
};

let scratch: string;
afterEach(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

const envOf = (over: PushEnv = {}): PushEnv => {
  scratch = mkdtempSync(join(tmpdir(), "odu-cache-push-"));
  return { HOME: scratch, ...over };
};

describe("pushing a closure", () => {
  it("uploads in dependency order, nar then narinfo, per path", async () => {
    const server = startServer();
    try {
      const env = envOf({ ODU_CACHE_TOKEN: "t" });
      const summary = await pushToCache({
        bucket: `${server.origin}/main`,
        paths: ["."],
        env,
        platform: PLATFORM,
        concurrency: 4,
      });
      expect(summary).toMatchObject({
        pushed: 3,
        skippedUpstream: 0,
        alreadyPresent: 0,
        failed: 0,
      });
      const uploads = server.seen.filter((seen) => seen.method === "PUT").map((seen) => seen.path);
      const order = uploads.map((path) => {
        const at = path.indexOf("/main/") + "/main/".length;
        const name = path.slice(at).replace(/^nar\//, "").replace(/\.narinfo$/, "").replace(/\.nar\.zst$/, "");
        const byPath = new Map([
          [LIBC, "libidn2"],
          [GLIBC, "glibc"],
          [HELLO, "hello"],
        ] as const);
        for (const [storePath, label] of byPath) {
          if (name.startsWith(storePathHash(storePath))) return label;
        }
        return "unknown";
      });
      // A nar and its narinfo per path, shallowest first.
      expect(order).toEqual([
        "libidn2",
        "libidn2",
        "glibc",
        "glibc",
        "hello",
        "hello",
      ]);
      expect(uploads[0]).toEndWith(".nar.zst");
      expect(uploads[1]).toEndWith(".narinfo");
    } finally {
      server.stop();
    }
  });

  it("retries a failed upload and does not re-send what landed", async () => {
    const server = startServer();
    try {
      server.missing = [LIBC];
      // The file name is the nar hash, which every entry shares.
      server.failNar.set(`${storePathHash(LIBC).padEnd(52, "0")}.nar.zst`, 2);
      const summary = await pushToCache({
        bucket: `${server.origin}/main`,
        paths: ["."],
        env: envOf({ ODU_CACHE_TOKEN: "t" }),
        platform: PLATFORM,
        attempts: 3,
      });
      expect(summary.pushed).toBe(1);
      expect(summary.failed).toBe(0);
      const narPuts = server.seen.filter(
        (seen) => seen.method === "PUT" && seen.path.endsWith(".nar.zst"),
      );
      expect(narPuts).toHaveLength(3);
      const infoPuts = server.seen.filter(
        (seen) => seen.method === "PUT" && seen.path.endsWith(".narinfo"),
      );
      expect(infoPuts).toHaveLength(1);
    } finally {
      server.stop();
    }
  });

  it("splits a large NAR into parts, retries one part, and joins them", async () => {
    const server = startServer();
    try {
      server.missing = [LIBC];
      const bytes = new TextEncoder().encode("0123456789");
      const narName = `${narHashBase32(entry(LIBC).narHash)}.nar.zst`;
      // The MIDDLE part fails once: a retry costs that part, not the path.
      server.partFailures.set(`${narName}:1`, 1);
      const lines: string[] = [];
      const summary = await pushToCache({
        bucket: `${server.origin}/main`,
        paths: ["."],
        env: envOf({ ODU_CACHE_TOKEN: "t" }),
        platform: {
          closure: async () => [entry(LIBC)],
          dump: () =>
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            }),
        },
        // Four bytes a part: ten bytes become three requests, which is the
        // whole point — Cloudflare refuses one hundred megabytes, not ten.
        partSize: 4,
        onLine: (line) => lines.push(line),
      });
      expect(summary).toMatchObject({ pushed: 1, failed: 0, held: [] });
      const parts = server.seen
        .filter((seen) => seen.method === "PUT" && seen.path.includes("/parts/"))
        .map((seen) => Number(seen.path.slice(seen.path.lastIndexOf("/") + 1)));
      expect(parts).toEqual([0, 1, 1, 2]);
      expect(server.completed).toEqual([{ file: narName, total: 3 }]);
      expect(server.seen.some((seen) => seen.method === "PUT" && seen.path.endsWith(".nar.zst"))).toBe(
        false,
      );
      // ONE LINE PER PART, and the retry names itself.
      expect(lines).toContain(`⏳ ${LIBC} part 1`);
      expect(lines).toContain(`↻ ${LIBC} part 2 (retry 1)`);
      expect(lines).toContain(`⏳ ${LIBC} part 3`);
      expect(lines).toContain(`✅ ${LIBC} stored`);
    } finally {
      server.stop();
    }
  });

  it("sends a NAR under the part size as one request", async () => {
    const server = startServer();
    try {
      server.missing = [LIBC];
      await pushToCache({
        bucket: `${server.origin}/main`,
        paths: ["."],
        env: envOf({ ODU_CACHE_TOKEN: "t" }),
        platform: {
          closure: async () => [entry(LIBC)],
          dump: () =>
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("small"));
                controller.close();
              },
            }),
        },
        partSize: 64,
      });
      expect(server.parts.size).toBe(0);
      expect(server.completed).toEqual([]);
      expect(
        server.seen.filter((seen) => seen.method === "PUT" && seen.path.endsWith(".nar.zst")),
      ).toHaveLength(1);
    } finally {
      server.stop();
    }
  });

  it("gives up after the attempts it was allowed, and names the path", async () => {
    const server = startServer();
    try {
      server.missing = [LIBC];
      server.failNar.set(`${storePathHash(LIBC).padEnd(52, "0")}.nar.zst`, 99);
      const summary = await pushToCache({
        bucket: `${server.origin}/main`,
        paths: ["."],
        env: envOf({ ODU_CACHE_TOKEN: "t" }),
        platform: PLATFORM,
        attempts: 2,
      });
      expect(summary.failed).toBe(1);
      expect(summary.failures[0]?.path).toBe(LIBC);
      expect(server.seen.filter((seen) => seen.method === "PUT")).toHaveLength(2);
    } finally {
      server.stop();
    }
  });

  it("repeats an upload the server accepted but could not import yet", async () => {
    const server = startServer();
    try {
      server.missing = [LIBC];
      // The first narinfo is 202 (a reference had not landed), the second is
      // 200 — the shape an out-of-order closure produces.
      server.deferOnce.add(storePathHash(LIBC));
      const summary = await pushToCache({
        bucket: `${server.origin}/main`,
        paths: ["."],
        env: envOf({ ODU_CACHE_TOKEN: "t" }),
        platform: PLATFORM,
      });
      expect(summary).toMatchObject({ pushed: 1, failed: 0 });
      const infoPuts = server.seen.filter(
        (seen) => seen.method === "PUT" && seen.path.endsWith(".narinfo"),
      );
      expect(infoPuts).toHaveLength(2);
      // The repeat is the NARINFO alone: the NAR is still staged on the
      // server, and re-streaming it to say "try again" is the cost this avoids.
      const narPuts = server.seen.filter(
        (seen) => seen.method === "PUT" && seen.path.endsWith(".nar.zst"),
      );
      expect(narPuts).toHaveLength(1);
    } finally {
      server.stop();
    }
  });

  it("sends the pair again when the deferred retry finds the bytes gone", async () => {
    const server = startServer();
    try {
      server.missing = [LIBC];
      server.deferOnce.add(storePathHash(LIBC));
      // The narinfo-only repeat is refused as "never uploaded", which is what a
      // restarted or swept server says — so the client falls back to the pair.
      server.narinfoOnlyRefusal = true;
      const summary = await pushToCache({
        bucket: `${server.origin}/main`,
        paths: ["."],
        env: envOf({ ODU_CACHE_TOKEN: "t" }),
        platform: PLATFORM,
      });
      expect(summary).toMatchObject({ pushed: 1, failed: 0 });
      const narPuts = server.seen.filter(
        (seen) => seen.method === "PUT" && seen.path.endsWith(".nar.zst"),
      );
      expect(narPuts).toHaveLength(2);
    } finally {
      server.stop();
    }
  });

  it("does not repeat a request the server refused outright", async () => {
    const server = startServer();
    try {
      server.missing = [LIBC];
      // 403 is the TOKEN being wrong. Repeating it streams the whole NAR again
      // for the same answer.
      server.narStatus.set(`${storePathHash(LIBC).padEnd(52, "0")}.nar.zst`, 403);
      const summary = await pushToCache({
        bucket: `${server.origin}/main`,
        paths: ["."],
        env: envOf({ ODU_CACHE_TOKEN: "t" }),
        platform: PLATFORM,
        attempts: 3,
      });
      expect(summary.failed).toBe(1);
      expect(
        server.seen.filter((seen) => seen.method === "PUT" && seen.path.endsWith(".nar.zst")),
      ).toHaveLength(1);
    } finally {
      server.stop();
    }
  });

  it("reports what the bucket already had, and what it refused as upstream", async () => {
    const server = startServer();
    try {
      server.missing = [HELLO];
      server.skipped = [LIBC];
      const summary = await pushToCache({
        bucket: `${server.origin}/main`,
        paths: ["."],
        env: envOf({ ODU_CACHE_TOKEN: "t" }),
        platform: PLATFORM,
      });
      expect(summary).toMatchObject({ pushed: 1, skippedUpstream: 1, alreadyPresent: 1, failed: 0 });
    } finally {
      server.stop();
    }
  });

  it("reports a hold in the server's own words, and does not fail", async () => {
    const server = startServer();
    try {
      server.missing = [LIBC];
      server.alwaysDefer.add(storePathHash(LIBC));
      const lines: string[] = [];
      const summary = await pushToCache({
        bucket: `${server.origin}/main`,
        paths: ["."],
        env: envOf({
          ODU_CACHE_TOKEN: "t",
          // THE BOARD, on the daemon's own name — the push was told the bucket
          // by URL, and its `see` line must still point at the page that
          // lists the hold, not at the substituter's root.
          ODU_WEB_ORIGIN: "https://board.example.org",
        }),
        platform: PLATFORM,
        onLine: (line) => lines.push(line),
      });
      // A HOLD IS REPORTED AND THE COMMAND RETURNS: no failure, no hang.
      expect(summary).toMatchObject({
        pushed: 0,
        held: [
          {
            path: LIBC,
            reason: `waiting for 1 reference that is neither here nor upstream: ${GLIBC}`,
          },
        ],
        failed: 0,
        pageUrl: "https://board.example.org/#/cache/main",
      });
      expect(lines[0]).toBe(
        "3 paths in the closure: 1 to push, 2 already here, 0 upstream",
      );
      expect(lines).toContain(`⏸ ${LIBC} held: ${summary.held[0]?.reason}`);
    } finally {
      server.stop();
    }
  });

  it("--wait stays until the bucket can serve the held path", async () => {
    const server = startServer();
    try {
      server.missing = [LIBC];
      server.alwaysDefer.add(storePathHash(LIBC));
      // The first `/missing` says the path is absent; the wait's next question
      // says it landed (a parallel pusher supplied the reference).
      server.missingOnlyFor = 1;
      const summary = await pushToCache({
        bucket: `${server.origin}/main`,
        paths: ["."],
        env: envOf({ ODU_CACHE_TOKEN: "t" }),
        platform: PLATFORM,
        wait: true,
        waitIntervalMs: 1,
        waitTimeoutMs: 2_000,
      });
      expect(summary).toMatchObject({ pushed: 1, held: [], failed: 0 });
      // The wait asks about the HELD paths, not the whole closure again.
      const last = server.seen.filter((seen) => seen.path.endsWith("/missing")).at(-1);
      const asked = JSON.parse(last?.body as string) as { paths: { path: string }[] };
      expect(asked.paths.map((entry) => entry.path)).toEqual([LIBC]);
    } finally {
      server.stop();
    }
  });

  it("asks the missing question once, with the closure's signatures", async () => {
    const server = startServer();
    try {
      server.missing = [];
      await pushToCache({
        bucket: `${server.origin}/main`,
        paths: ["."],
        env: envOf({ ODU_CACHE_TOKEN: "t" }),
        platform: PLATFORM,
      });
      const asked = server.seen.filter((seen) => seen.path.endsWith("/missing"));
      expect(asked).toHaveLength(1);
      expect(asked[0]?.path).toBe("/_odu/v1/buckets/main/missing");
      const sent = JSON.parse(asked[0]?.body as string) as { paths: { path: string }[] };
      expect(sent.paths.map((entry) => entry.path).sort()).toEqual([GLIBC, HELLO, LIBC].sort());
    } finally {
      server.stop();
    }
  });
});

describe("token precedence", () => {
  it("prefers --token-file, then the environment, then the credentials file", async () => {
    const env = envOf({ ODU_CACHE_TOKEN: "from-env" });
    const file = join(scratch, "token");
    writeFileSync(file, "from-file\n");
    await saveCredential(env, "http://127.0.0.1:1", "from-credentials");

    expect(await resolveToken(env, "http://127.0.0.1:1", file)).toBe("from-file");
    expect(await resolveToken(env, "http://127.0.0.1:1", undefined)).toBe("from-env");
    expect(await resolveToken({ HOME: scratch }, "http://127.0.0.1:1", undefined)).toBe(
      "from-credentials",
    );
    expect(await resolveToken({ HOME: scratch }, "http://127.0.0.1:2", undefined)).toBeNull();
  });

  it("sends the token it resolved, and refuses to push without one", async () => {
    const server = startServer();
    try {
      await pushToCache({
        bucket: `${server.origin}/main`,
        paths: ["."],
        env: envOf({ ODU_CACHE_TOKEN: "secret-token" }),
        platform: PLATFORM,
      });
      expect(server.seen.every((seen) => seen.authorization === "Bearer secret-token")).toBe(true);
      await expect(
        pushToCache({
          bucket: `${server.origin}/main`,
          paths: ["."],
          env: { HOME: scratch },
          platform: PLATFORM,
        }),
      ).rejects.toThrow(/no token/);
    } finally {
      server.stop();
    }
  });

  it("writes the credentials file 0600, one entry per origin", async () => {
    const env = envOf();
    await saveCredential(env, "http://127.0.0.1:18440/", "a");
    await saveCredential(env, "http://127.0.0.1:18440", "b");
    const path = credentialsPath(env);
    expect(path).toBe(join(scratch, ".config", "odu", "cache", "credentials"));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ "http://127.0.0.1:18440": "b" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("resolving the bucket argument", () => {
  it("takes a full URL as its own origin", async () => {
    const env = envOf();
    expect(await resolveBucket(env, "https://cache.example.com/main")).toEqual({
      origin: "https://cache.example.com",
      name: "main",
    });
    expect(await resolveBucket(env, "https://cache.example.com/team/main/")).toEqual({
      origin: "https://cache.example.com",
      name: "main",
    });
    expect(await resolveBucket(env, "https://cache.example.com/")).toHaveProperty("error");
  });

  it("lets --origin beat a stored credential", async () => {
    // A machine logged in to one cache must still be able to push to a second.
    const env = envOf();
    await saveCredential(env, "http://127.0.0.1:9999", "t");
    expect(await resolveBucket(env, "main", "http://127.0.0.1:1234")).toEqual({
      origin: "http://127.0.0.1:1234",
      name: "main",
    });
    // A full URL still names its own origin; the flag cannot move it.
    expect(await resolveBucket(env, "https://cache.example.com/main", "http://127.0.0.1:1234")).toEqual({
      origin: "https://cache.example.com",
      name: "main",
    });
  });

  it("resolves a bare name against the one origin this machine logged in to", async () => {
    const env = envOf({ ODU_WEB_ORIGIN: "http://127.0.0.1:18440" });
    expect(await resolveBucket(env, "main")).toEqual({
      origin: "http://127.0.0.1:18440",
      name: "main",
    });
    await saveCredential(env, "http://127.0.0.1:9999", "t");
    expect(await resolveBucket(env, "main")).toEqual({
      origin: "http://127.0.0.1:9999",
      name: "main",
    });
    await saveCredential(env, "http://127.0.0.1:8888", "t");
    expect(await resolveBucket(env, "main")).toHaveProperty("error");
  });
});

describe("the narinfo a push sends", () => {
  it("names the nar it uploaded and carries the client's own signatures", () => {
    const text = formatPushNarinfo(
      {
        ...entry(HELLO, [GLIBC]),
        deriver: "/nix/store/y1kh9arkh7w7am664yqbnnrfpsisqcdc-hello-2.12.3.drv",
        sigs: ["lane-1:AAAA"],
      },
      "abc.nar.zst",
    );
    expect(text).toContain("URL: nar/abc.nar.zst");
    expect(text).toContain("Compression: zstd");
    expect(text).toContain(
      "References: pqyiidz5mi73wv5f91d48s9plcqyj5bz-glibc-2.44-57",
    );
    expect(text).toContain("Deriver: y1kh9arkh7w7am664yqbnnrfpsisqcdc-hello-2.12.3.drv");
    expect(text).toContain("Sig: lane-1:AAAA");
  });
});
