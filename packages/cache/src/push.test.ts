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
  describeCache,
  discoveryToken,
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
    ca: null,
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
  upload: string | null;
  body: string;
}

interface Server {
  origin: string;
  seen: Seen[];
  /** How many times each path's nar upload should fail before succeeding. */
  failNar: Map<string, number>;
  /** Status to answer a nar upload with, before the failure count applies. */
  narStatus: Map<string, number>;
  /** Store paths whose narinfo answers 202 — a success code that is not
   *  "stored", so a refusal to this pusher. */
  answer202: Set<string>;
  /** Parts received, keyed `${file}:${index}`. */
  parts: Map<string, string>;
  /** How many times a part answers 500 before succeeding, keyed the same. */
  partFailures: Map<string, number>;
  /** Every completed join, in order. */
  completed: { file: string; total: number }[];
  /** How many joins answer 500 before one succeeds. */
  completeFailures: number;
  /** How many `/missing` calls still answer the current list; `undefined`
   *  means every call does. */
  missingCalls: number;
  missingOnlyFor: number | undefined;
  /** Answer a narinfo PUT that carries no preceding NAR with a 400 saying the
   *  bytes are gone — what a restarted server says. */
  narinfoOnlyRefusal: boolean;
  missing: string[];
  skipped: string[];
  /** The substituter URL the bucket reports — its own domain when it has one.
   *  `null` answers like a daemon that predates the field. */
  substituter: string | null;
  stop: () => void;
  /** Answer the negotiation with a 404, the way an origin from before 2.9
   *  does — it has no such route. */
  negotiation404: boolean;
  /** When set, `begin` answers `direct` with this part size, and the same
   *  server plays the STORE under `/store/…` — what a presigned URL points
   *  at. `null` answers `staged`, which is every other test here. */
  directPartSize: number | null;
  /** Every `begin` this server answered, in order, as `<file>` — so a retry
   *  is visible as a SECOND one for the same path. */
  begun: string[];
  /** What the fake store was handed: its key, and the bytes. */
  stored: Map<string, string>;
  /** How many part PUTs the fake store refuses (403, an expired presign)
   *  before it starts taking them. */
  storeRefusals: number;
  /** Direct joins, in order: the upload and the parts it named. */
  joined: { upload: string; parts: { index: number; etag: string }[] }[];
}

function startServer(): Server {
  const state: Server = {
    origin: "",
    seen: [],
    failNar: new Map(),
    narStatus: new Map(),
    answer202: new Set(),
    parts: new Map(),
    partFailures: new Map(),
    completed: [],
    completeFailures: 0,
    missingCalls: 0,
    missingOnlyFor: undefined,
    narinfoOnlyRefusal: false,
    missing: [LIBC, GLIBC, HELLO],
    skipped: [],
    substituter: null,
    negotiation404: false,
    directPartSize: null,
    begun: [],
    stored: new Map(),
    storeRefusals: 0,
    joined: [],
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
        upload: request.headers.get("x-odu-upload"),
        body,
      });

      // ── THE STORE, when a test turns direct mode on ───────────────────
      //
      // A presigned URL is opaque to the client, so the fake mints one that
      // points back here under `/store/…`. What is asserted of it is what a
      // real store would hold the client to: the bytes arrive, and a part's
      // ETag is the store's own answer.
      if (request.method === "PUT" && url.pathname.startsWith("/store/")) {
        if (state.storeRefusals > 0) {
          state.storeRefusals -= 1;
          return new Response("expired", { status: 403 });
        }
        const key = url.pathname.slice("/store/".length);
        state.stored.set(key, body);
        return new Response(null, { status: 200, headers: { etag: `"etag-${key}"` } });
      }

      // ── THE NEGOTIATION ───────────────────────────────────────────────
      if (request.method === "POST" && url.pathname.endsWith("/upload")) {
        if (state.negotiation404) return new Response("not found", { status: 404 });
        const file = url.pathname.slice(
          url.pathname.lastIndexOf("/nar/") + 5,
          -"/upload".length,
        );
        state.begun.push(file);
        if (state.directPartSize === null) return Response.json({ mode: "staged" });
        const upload = `u${state.begun.length}`;
        return Response.json({
          mode: "direct",
          upload,
          partSize: state.directPartSize,
          // PART 0, never a plain PUT — the shape the server really answers.
          part: `${state.origin}/store/${upload}-part-0`,
        });
      }
      if (request.method === "GET" && url.pathname.includes("/upload/")) {
        const [upload = "", , index = ""] = url.pathname
          .slice(url.pathname.indexOf("/upload/") + "/upload/".length)
          .split("/");
        return Response.json({ url: `${state.origin}/store/${upload}-part-${index}` });
      }
      if (request.method === "POST" && url.pathname.includes("/upload/")) {
        const upload = url.pathname.slice(
          url.pathname.indexOf("/upload/") + "/upload/".length,
          -"/complete".length,
        );
        const { parts } = JSON.parse(body) as { parts: { index: number; etag: string }[] };
        state.joined.push({ upload, parts });
        return Response.json({ parts: parts.length, bytes: 0 });
      }
      if (url.pathname.endsWith("/missing")) {
        state.missingCalls += 1;
        const substituter =
          state.substituter === null ? {} : { substituter: state.substituter };
        if (state.missingOnlyFor !== undefined && state.missingCalls > state.missingOnlyFor) {
          return Response.json({ missing: [], skippedUpstream: [], ...substituter });
        }
        return Response.json({
          missing: state.missing,
          skippedUpstream: state.skipped,
          ...substituter,
        });
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
        if (state.completeFailures > 0) {
          state.completeFailures -= 1;
          return new Response("nope", { status: 500 });
        }
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
        if (state.answer202.has(hash)) {
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
      expect(summary).toMatchObject({ pushed: 1, failed: 0 });
      const parts = server.seen
        .filter((seen) => seen.method === "PUT" && seen.path.includes("/parts/"))
        .map((seen) => Number(seen.path.slice(seen.path.lastIndexOf("/") + 1)));
      expect(parts).toEqual([0, 1, 1, 2]);
      expect(server.completed).toEqual([{ file: narName, total: 3 }]);
      // ONE SESSION for every part and the join (contract 2.4): the parts are
      // this upload's own, whoever else is sending the same path.
      const sessions = new Set(
        server.seen
          .filter((seen) => seen.path.includes("/parts/") || seen.path.endsWith("/complete"))
          .map((seen) => seen.upload),
      );
      expect(sessions.size).toBe(1);
      expect([...sessions][0]).toMatch(/^[0-9a-f-]{36}$/);
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

  it("keeps ONE upload session across a retried join", async () => {
    // A FAILED JOIN RETRIES THE WHOLE NAR; a fresh session per attempt would
    // abandon the previous attempt's parts to the sweep for an hour.
    const server = startServer();
    try {
      server.missing = [LIBC];
      server.completeFailures = 1;
      const bytes = new TextEncoder().encode("ten bytes!");
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
        partSize: 4,
      });
      expect(summary).toMatchObject({ pushed: 1, failed: 0 });
      const chunked = server.seen.filter(
        (seen) => seen.path.includes("/parts/") || seen.path.endsWith("/complete"),
      );
      // Two attempts: 3 parts + a join each.
      expect(chunked).toHaveLength(8);
      expect(new Set(chunked.map((seen) => seen.upload)).size).toBe(1);
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

  it("reassembles the same bytes with 3+ parts and uneven source chunks", async () => {
    const server = startServer();
    try {
      server.missing = [LIBC];
      const payload = "0123456789abcdef".repeat(700);
      const chunks: string[] = [];
      for (let at = 0; at < payload.length; ) {
        const size = (at % 7) * 13 + 1;
        chunks.push(payload.slice(at, at + size));
        at += size;
      }
      const narName = `${narHashBase32(entry(LIBC).narHash)}.nar.zst`;
      const summary = await pushToCache({
        bucket: `${server.origin}/main`,
        paths: ["."],
        env: envOf({ ODU_CACHE_TOKEN: "t" }),
        platform: {
          closure: async () => [entry(LIBC)],
          dump: () =>
            new ReadableStream({
              start(controller) {
                for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
                controller.close();
              },
            }),
        },
        partSize: 1000,
      });
      expect(summary).toMatchObject({ pushed: 1, failed: 0 });
      const total = server.completed[0]?.total ?? 0;
      expect(total).toBeGreaterThan(2);
      let joined = "";
      for (let index = 0; index < total; index++) {
        joined += server.parts.get(`${narName}:${index}`) ?? "";
      }
      expect(joined).toBe(payload);
    } finally {
      server.stop();
    }
  });

  // ── UPLOADS THAT GO STRAIGHT TO THE STORE (PLAN 2.9) ──────────────────
  //
  // What the client is held to: it ASKS first, it sends the bytes where it
  // was told and nowhere else, it reports the ETags the store answered, and
  // a failure out at the store re-begins the path rather than carrying a
  // dead upload id forward.

  /** A platform whose NAR is `payload`, delivered in small chunks. */
  const dumping = (payload: string): PushPlatform => ({
    closure: async () => [entry(LIBC)],
    dump: () =>
      new ReadableStream({
        start(controller) {
          for (let at = 0; at < payload.length; at += 7) {
            controller.enqueue(new TextEncoder().encode(payload.slice(at, at + 7)));
          }
          controller.close();
        },
      }),
  });

  it("asks where the bytes go before it sends any, and takes the staged answer", async () => {
    const server = startServer();
    try {
      server.missing = [LIBC];
      const summary = await pushToCache({
        bucket: `${server.origin}/main`,
        paths: ["."],
        env: envOf({ ODU_CACHE_TOKEN: "t" }),
        platform: dumping("small"),
        partSize: 64,
      });
      expect(summary).toMatchObject({ pushed: 1, failed: 0, mode: "staged" });
      // The negotiation comes first, and the NAR still goes through odu.
      const paths = server.seen.map((seen) => `${seen.method} ${seen.path}`);
      const begun = paths.findIndex((line) => line.endsWith("/upload"));
      const sent = paths.findIndex((line) => line.startsWith("PUT") && line.endsWith(".nar.zst"));
      expect(begun).toBeGreaterThanOrEqual(0);
      expect(sent).toBeGreaterThan(begun);
      expect(server.stored.size).toBe(0);
    } finally {
      server.stop();
    }
  });

  it("puts a one-part NAR straight into the store, and odu takes no bytes", async () => {
    const server = startServer();
    try {
      server.missing = [LIBC];
      server.directPartSize = 1000;
      const summary = await pushToCache({
        bucket: `${server.origin}/main`,
        paths: ["."],
        env: envOf({ ODU_CACHE_TOKEN: "t" }),
        platform: dumping("a NAR that fits in one part"),
        partSize: 64,
      });
      expect(summary).toMatchObject({ pushed: 1, failed: 0, mode: "direct" });
      // ONE PART, at the URL the plan carried — no extra round trip to sign
      // it, and still a part, so the key stops being writable the moment the
      // completion lands.
      expect([...server.stored.keys()]).toEqual(["u1-part-0"]);
      expect(server.stored.get("u1-part-0")).toBe("a NAR that fits in one part");
      expect(server.joined).toEqual([
        { upload: "u1", parts: [{ index: 0, etag: '"etag-u1-part-0"' }] },
      ]);
      // AND NOBODY ASKED ODU TO SIGN ANYTHING: part 0 came with the plan.
      expect(server.seen.filter((seen) => seen.path.includes("/parts/"))).toEqual([]);
      // NOT ONE NAR BYTE CROSSED ODU: every body it saw is a narinfo or a
      // small JSON document.
      const toOdu = server.seen.filter(
        (seen) => seen.method === "PUT" && seen.path.includes("/nar/"),
      );
      expect(toOdu).toEqual([]);
    } finally {
      server.stop();
    }
  });

  it("sends each part to its own presigned URL and reports the store's ETags", async () => {
    const server = startServer();
    try {
      server.missing = [LIBC];
      server.directPartSize = 10;
      const payload = "0123456789abcdefghij!";
      const summary = await pushToCache({
        bucket: `${server.origin}/main`,
        paths: ["."],
        env: envOf({ ODU_CACHE_TOKEN: "t" }),
        platform: dumping(payload),
        // THE CLIENT'S `--part-size` IS A FLOOR HERE, and the server's answer
        // is what the slicing uses: 10 bytes, not this.
        partSize: 64,
      });
      expect(summary).toMatchObject({ pushed: 1, failed: 0, mode: "direct" });
      expect(server.stored.get("u1-part-0")).toBe("0123456789");
      expect(server.stored.get("u1-part-1")).toBe("abcdefghij");
      expect(server.stored.get("u1-part-2")).toBe("!");
      // The parts joined in order are the NAR, and the ETags are the ones the
      // store answered — the only thing the client could not have invented.
      expect(server.joined).toEqual([
        {
          upload: "u1",
          parts: [
            { index: 0, etag: '"etag-u1-part-0"' },
            { index: 1, etag: '"etag-u1-part-1"' },
            { index: 2, etag: '"etag-u1-part-2"' },
          ],
        },
      ]);
    } finally {
      server.stop();
    }
  });

  it("begins the path again when the store refuses a part, rather than reusing the upload", async () => {
    const server = startServer();
    try {
      server.missing = [LIBC];
      server.directPartSize = 10;
      // ONE 403 — an expired presign, which is the failure this retry exists
      // for — and then the store takes everything.
      server.storeRefusals = 1;
      const summary = await pushToCache({
        bucket: `${server.origin}/main`,
        paths: ["."],
        env: envOf({ ODU_CACHE_TOKEN: "t" }),
        platform: dumping("0123456789abcdefghij!"),
        attempts: 2,
      });
      expect(summary).toMatchObject({ pushed: 1, failed: 0, mode: "direct" });
      // TWO BEGINS for the one path, and the join names the SECOND upload's
      // parts: a retry never completes an upload whose parts it half sent.
      const narName = `${narHashBase32(entry(LIBC).narHash)}.nar.zst`;
      expect(server.begun).toEqual([narName, narName]);
      expect(server.joined.map((join) => join.upload)).toEqual(["u2"]);
      expect(server.stored.get("u2-part-0")).toBe("0123456789");
    } finally {
      server.stop();
    }
  });

  it("refuses an origin that cannot negotiate, naming the version it needs", async () => {
    const server = startServer();
    try {
      server.missing = [LIBC];
      server.negotiation404 = true;
      // A 404 for the negotiation is a cache from before 2.9. There is no
      // falling back to staged: on an S3 bucket that would quietly go on
      // pushing every byte through the daemon.
      const summary = await pushToCache({
        bucket: `${server.origin}/main`,
        paths: ["."],
        env: envOf({ ODU_CACHE_TOKEN: "t" }),
        platform: dumping("small"),
      });
      expect(summary.failed).toBe(1);
      expect(summary.failures[0]?.message).toContain("cache surface 4.2");
      // ONE ATTEMPT: an origin that does not speak it will not speak it twice.
      expect(server.begun).toEqual([]);
      expect(server.seen.filter((seen) => seen.path.endsWith("/upload"))).toHaveLength(1);
    } finally {
      server.stop();
    }
  });

  it("refuses a success code it does not know, once, rather than counting it stored", async () => {
    const server = startServer();
    try {
      server.missing = [LIBC];
      server.answer202.add(storePathHash(LIBC));
      const lines: string[] = [];
      const summary = await pushToCache({
        bucket: `${server.origin}/main`,
        paths: ["."],
        env: envOf({ ODU_CACHE_TOKEN: "t" }),
        platform: PLATFORM,
        onLine: (line) => lines.push(line),
      });
      expect(summary).toMatchObject({
        pushed: 0,
        failed: 1,
        failures: [{ path: LIBC, message: expect.stringContaining("answered 202") }],
      });
      expect(summary).not.toHaveProperty("held");
      expect(lines.some((line) => line.startsWith(`❌ ${LIBC} refused`))).toBe(true);
      const narinfoPuts = server.seen.filter(
        (request) => request.method === "PUT" && request.path.endsWith(".narinfo"),
      );
      expect(narinfoPuts).toHaveLength(1);
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
      // EVERY PATH THE BUCKET SERVES, and only those: the upstream-signed one
      // is absent by design, so a caller verifying "served" never asks the
      // bucket for a path it was right to refuse.
      expect([...summary.served].sort()).toEqual([GLIBC, HELLO].sort());
      // A DAEMON THAT DID NOT SAY gets the address this client addressed it
      // at — the same URL for a bucket with no domain of its own.
      expect(summary.substituter).toBe(`${server.origin}/cache/main`);
    } finally {
      server.stop();
    }
  });

  it("carries the bucket's own substituter URL when the bucket names one", async () => {
    // A DOMAIN IS THE WHOLE ADDRESS: a bucket reached at its own name
    // substitutes from that name, not from `<origin>/cache/<bucket>`, and a
    // caller proving the push must ask where Nix will ask.
    const server = startServer();
    try {
      server.missing = [];
      server.substituter = "https://cache.example.org";
      const summary = await pushToCache({
        bucket: `${server.origin}/main`,
        paths: ["."],
        env: envOf({ ODU_CACHE_TOKEN: "t" }),
        platform: PLATFORM,
      });
      expect(summary.substituter).toBe("https://cache.example.org");
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

describe("a cache that describes itself (`--cache`)", () => {
  /** A `fetch` that answers one body, and remembers what it was asked —
   *  including the authorization it carried, which is what a private bucket
   *  decides on. */
  const answering = (
    reply: () => Response | Promise<Response>,
  ): { send: typeof fetch; asked: string[]; auth: (string | null)[] } => {
    const asked: string[] = [];
    const auth: (string | null)[] = [];
    return {
      asked,
      auth,
      send: (async (url: string | URL | Request, init?: RequestInit) => {
        asked.push(String(url));
        auth.push(
          ((init?.headers ?? {}) as Record<string, string>)["authorization"] ?? null,
        );
        return await reply();
      }) as unknown as typeof fetch,
    };
  };

  const INFO =
    "StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 41\n" +
    "Odu-Origin: https://odu.example.org\nOdu-Bucket: kolu-r2\n";

  it("reads the push origin and the bucket off the substituter's nix-cache-info", async () => {
    // THE ONE FACT A CONSUMER HAS is the substituter URL. The push address
    // cannot be derived from it: this one is an R2 domain that answers GET.
    const { send, asked } = answering(() => new Response(INFO, { status: 200 }));
    expect(await describeCache("https://cache.kolu.dev/kolu-r2/", send)).toEqual({
      origin: "https://odu.example.org",
      bucket: "kolu-r2",
    });
    expect(asked).toEqual(["https://cache.kolu.dev/kolu-r2/nix-cache-info"]);
  });

  it("refuses a cache that answers without the two lines, naming the URL", async () => {
    // cache.nixos.org, or an odu from before this: guessing an origin from the
    // substituter is how a push ends up at a URL nobody owns.
    const { send } = answering(
      () => new Response("StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n", { status: 200 }),
    );
    const refusal = await describeCache("https://cache.nixos.org", send).catch((err: Error) => err);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("https://cache.nixos.org/nix-cache-info");
    expect((refusal as Error).message).toContain("Odu-Origin");
  });

  it("refuses a cache that does not answer, naming the URL", async () => {
    const dead = (async () => {
      throw new Error("getaddrinfo ENOTFOUND cache.gone.example");
    }) as unknown as typeof fetch;
    const refusal = await describeCache("https://cache.gone.example", dead).catch(
      (err: Error) => err,
    );
    expect((refusal as Error).message).toContain("https://cache.gone.example/nix-cache-info");
    expect((refusal as Error).message).toContain("ENOTFOUND");

    const { send } = answering(() => new Response("no", { status: 404 }));
    const missing = await describeCache("https://cache.kolu.dev/gone", send).catch(
      (err: Error) => err,
    );
    expect((missing as Error).message).toContain("answered 404");
    // AND IT SAYS WHY THAT MIGHT BE: an anonymous read of a private bucket is
    // a 404, so "no such cache" and "not yours" look identical from here.
    expect((missing as Error).message).toContain("no token was sent");
  });

  it("carries the bucket's token, because a private bucket answers nobody without one", async () => {
    // A PRIVATE BUCKET IS `404 no such bucket` TO AN ANONYMOUS READER, and its
    // substituter is always odu's own (a private bucket is never store-fronted),
    // so an unauthenticated discovery would make exactly the buckets that need
    // a token unpushable. The token is the push's own, one request earlier.
    const { send, auth } = answering(() => new Response(INFO, { status: 200 }));
    expect(await describeCache("https://odu.example.org/cache/private", send, "odc_write")).toEqual(
      { origin: "https://odu.example.org", bucket: "kolu-r2" },
    );
    expect(auth).toEqual(["Bearer odc_write"]);

    // A refusal of the token this machine DOES hold says that, rather than
    // telling a CI job to set a variable it already set.
    const denied = answering(() => new Response("", { status: 403 }));
    const refusal = await describeCache("https://odu.example.org/cache/private", denied.send, "odc_write").catch(
      (err: Error) => err,
    );
    expect((refusal as Error).message).toContain("answered 403");
    expect((refusal as Error).message).toContain("the token this machine holds");
  });

  it("resolves that token from the push's own three sources", async () => {
    // The file and the variable are origin-free. The credentials file is keyed
    // by origin, and the origin is what is being discovered — so the key is the
    // SUBSTITUTER's own origin, which is where this request is going.
    const env = envOf({ ODU_CACHE_TOKEN: "odc_from_env" });
    const file = join(scratch, "token");
    writeFileSync(file, "odc_from_file\n");
    await saveCredential(env, "https://odu.example.org", "odc_from_login");

    expect(await discoveryToken(env, "https://cache.kolu.dev/kolu-r2", file)).toBe("odc_from_file");
    expect(await discoveryToken(env, "https://cache.kolu.dev/kolu-r2", undefined)).toBe(
      "odc_from_env",
    );
    expect(await discoveryToken({ HOME: scratch }, "https://odu.example.org/cache/private", undefined)).toBe(
      "odc_from_login",
    );
    // A cache this machine has never logged in to is anonymous, honestly.
    expect(
      await discoveryToken({ HOME: scratch }, "https://cache.kolu.dev/kolu-r2", undefined),
    ).toBeNull();
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

describe("a derivation argument", () => {
  it("is skipped, named, and never uploaded", async () => {
    const server = startServer();
    try {
      const drv = "/nix/store/dddddddddddddddddddddddddddddddd-thing.drv";
      const lines: string[] = [];
      const summary = await pushToCache({
        bucket: `${server.origin}/main`,
        paths: [drv],
        env: envOf({ ODU_CACHE_TOKEN: "t" }),
        platform: PLATFORM,
        onLine: (line) => lines.push(line),
      });
      expect(summary).toMatchObject({ pushed: 0, failed: 0, skippedDerivation: [drv] });
      expect(lines).toContain(`⏭ ${drv} skipped-derivation`);
      // The only request a derivation may cause is the consumer facts (the
      // page link); NO upload, no missing question.
      expect(server.seen.filter((seen) => seen.method === "PUT")).toEqual([]);
    } finally {
      server.stop();
    }
  });
});
