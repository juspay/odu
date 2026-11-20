/**
 * `HttpRouter` ranks by specificity, so these literal and prefixed paths beat
 * the shell's `GET /*` catch-all whichever way round they go in.
 *
 * The router DECODES `%2F`, so a `:name` of `..%2F..%2Fx` would otherwise be a
 * path segment in a `join()`.
 *
 * `Authorization: Bearer` and HTTP Basic are both accepted — Basic with any
 * username and the token as the password is what `nix copy --to` sends through
 * curl.
 *
 * `find-my-way` falls back from HEAD to GET, and `HttpRouter.add` cannot even
 * register a HEAD, so the narinfo handler branches on the method.
 */

import { Effect, Layer, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { ClaimedRoutes } from "@odu/cordis/services";
import { type Cache, type NarSource } from "./cache";
import type { ByteRange, UploadedPart } from "@odu/objects";
import {
  CACHE_MOUNT,
  CACHE_ROUTE_PATHS,
  HASH_PATTERN,
  NARINFO_SUFFIX,
  PARTS_HEADER,
  PUSH_API,
  provenanceStated,
  UPLOAD_SESSION_HEADER,
} from "./paths";
import { isUploadSession } from "./staging";
import type { BucketRow, Scope } from "./db";
import { isSafeNarFileName, isSafeStorePathHash } from "./narinfo";
import {
  actionsBlock,
  FLAKE_CONFIG_NOTE,
  flakeBlock,
  MACHINE_CONFIG_NOTE,
  MAX_NAR_PART_BYTES,
  netrcBlock,
  nixConfBlock,
  nixOsBlock,
  pushBlock,
  useBlock,
  useCommand,
  type CacheBucketIdentity,
} from "./surface";


function observedBody(
  body: ReadableStream<Uint8Array>,
  onDone: (bytes: number, cancelled: boolean, error: string | null) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let bytes = 0;
  let finished = false;
  const finish = (cancelled: boolean, error: string | null): void => {
    if (finished) return;
    finished = true;
    onDone(bytes, cancelled, error);
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          finish(false, null);
          controller.close();
          return;
        }
        bytes += next.value.length;
        controller.enqueue(next.value);
      } catch (err) {
        finish(false, String((err as Error).message ?? err));
        controller.error(err);
      }
    },
    async cancel(reason) {
      finish(true, null);
      await reader.cancel(reason).catch(() => {});
    },
  });
}

function rangeOf(header: string | undefined, size: number): ByteRange | null | "unsatisfiable" {
  const range = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (range === null) return null;
  const first = range[1] === "" ? null : Number(range[1]);
  const last = range[2] === "" ? null : Number(range[2]);
  // `bytes=-` names no bytes, and a zero-length suffix names none either.
  if (first === null && (last === null || last === 0)) return "unsatisfiable";
  // `bytes=-N` is the LAST N bytes, not "end at N". An open-ended request at or
  // past the size has nothing to give.
  if (first !== null && first >= size) return "unsatisfiable";
  const start = first ?? (last === null ? 0 : Math.max(0, size - last));
  const end = Math.min(first === null ? size - 1 : (last ?? size - 1), size - 1);
  if (first !== null && last !== null && (first > last || end < start)) return "unsatisfiable";
  return { start, end };
}

function narResponse(
  cache: Cache,
  request: HttpServerRequest.HttpServerRequest,
  bucket: string,
  file: string,
  source: NarSource,
  headers: Record<string, string>,
): Effect.Effect<HttpServerResponse.HttpServerResponse> {
  const started = performance.now();
  const at = file.indexOf(".nar");
  const hash = at === -1 ? file : file.slice(0, at);
  const served = (kind: "object" | "transition" | "redirect") =>
    (bytes: number, cancelled: boolean, error: string | null): void =>
      cache.log("cache.nar.served", {
        bucket,
        hash,
        path: source.storePath,
        bytes,
        ms: Math.round(performance.now() - started),
        source: kind,
        cancelled,
        ...(error === null ? {} : { error }),
      });
  const streamed = (
    body: ReadableStream<Uint8Array>,
    kind: "object" | "transition",
    options: { status?: number; headers: Record<string, string> },
  ): HttpServerResponse.HttpServerResponse =>
    HttpServerResponse.stream(
      Stream.fromReadableStream({
        evaluate: () => observedBody(body, served(kind)),
        onError: (err) => err,
      }),
      { contentType: "application/x-nix-nar", ...options },
    );
  if (source.kind === "legacy") {
    return Effect.succeed(streamed(source.stream, "transition", { headers }));
  }
  /**
   * A `307` — not a `302` — because the method must survive the hop: a HEAD
   * that came back as a GET would hand a client asking "is it there" a whole
   * NAR.
   */
  if (source.kind === "redirect") {
    served("redirect")(0, false, null);
    return Effect.succeed(
      HttpServerResponse.empty({
        status: 307,
        headers: { location: source.url.href, "cache-control": "private, no-store" },
      }),
    );
  }
  const range = rangeOf(request.headers["range"], source.size);
  if (range === "unsatisfiable") return Effect.succeed(HttpServerResponse.empty({ status: 416 }));
  return Effect.map(
    Effect.promise(() => source.read(range ?? undefined)),
    (body) => {
      if (body === null) return HttpServerResponse.empty({ status: 404 });
      const length = range === null ? source.size : range.end - range.start + 1;
      return streamed(body, "object", {
        ...(range === null ? {} : { status: 206 }),
        headers: {
          ...headers,
          "content-type": "application/x-nix-nar",
          "content-length": String(length),
          "accept-ranges": "bytes",
          ...(range === null ? {} : { "content-range": `bytes ${range.start}-${range.end}/${source.size}` }),
        },
      });
    },
  );
}

function admit(
  cache: Cache,
  request: HttpServerRequest.HttpServerRequest,
  name: string,
  need: Scope,
): { ok: true; bucket: BucketRow } | { ok: false; response: HttpServerResponse.HttpServerResponse } {
  const bucket = cache.bucket(name);
  if (bucket === null) {
    cache.log("cache.request.refused", {
      method: request.method,
      path: request.url,
      status: 404,
      reason: `no bucket "${name}"`,
    });
    return { ok: false, response: HttpServerResponse.empty({ status: 404 }) };
  }
  return authorize(cache, request, bucket, need);
}

function hostOf(request: HttpServerRequest.HttpServerRequest): string {
  const raw = (request.headers["host"] ?? "").trim().toLowerCase();
  const colon = raw.indexOf(":");
  return colon === -1 ? raw : raw.slice(0, colon);
}

function admitByHost(
  cache: Cache,
  request: HttpServerRequest.HttpServerRequest,
  need: Scope,
): { ok: true; bucket: BucketRow } | { ok: false; response: HttpServerResponse.HttpServerResponse } {
  const bucket = cache.bucketByDomain(hostOf(request));
  if (bucket === null) {
    cache.log("cache.request.refused", {
      method: request.method,
      path: request.url,
      status: 404,
      reason: `no bucket "${hostOf(request)}"`,
    });
    return { ok: false, response: HttpServerResponse.empty({ status: 404 }) };
  }
  return authorize(cache, request, bucket, need);
}

function authorize(
  cache: Cache,
  request: HttpServerRequest.HttpServerRequest,
  bucket: BucketRow,
  need: Scope,
): { ok: true; bucket: BucketRow } | { ok: false; response: HttpServerResponse.HttpServerResponse } {
  const verdict = cache.authorize(request.headers["authorization"], bucket, need);
  if (!verdict.ok) {
    cache.log("cache.request.refused", {
      method: request.method,
      path: request.url,
      bucket: bucket.name,
      status: verdict.status,
      reason: verdict.message,
    });
    return {
      ok: false,
      response: HttpServerResponse.text(verdict.message, { status: verdict.status }),
    };
  }
  return { ok: true, bucket };
}

/**
 * The module's nginx honours `private, no-store`, and bypasses its cache on
 * any request that carries `Authorization`.
 */
function readHeaders(bucket: BucketRow): Record<string, string> {
  return bucket.isPublic ? {} : { "cache-control": "private, no-store" };
}

function narinfoAnswer(
  cache: Cache,
  request: HttpServerRequest.HttpServerRequest,
  bucket: BucketRow,
  hash: string,
): HttpServerResponse.HttpServerResponse {
  const text = cache.narinfoText(bucket, hash);
  cache.log("cache.narinfo.served", { bucket: bucket.name, hash, hit: text !== null });
  if (text === null) return HttpServerResponse.empty({ status: 404 });
  cache.touch(bucket, hash);
  return request.method === "HEAD"
    ? HttpServerResponse.empty({ status: 200, headers: readHeaders(bucket) })
    : HttpServerResponse.text(text, {
        contentType: "text/x-nix-narinfo",
        headers: readHeaders(bucket),
      });
}

function narinfoRoot(cache: Cache) {
  return (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const hash = yield* param("hash");
      if (!isSafeStorePathHash(hash)) return refused(cache, request, `"${hash}" is not a store path hash`);
      const admitted = admitByHost(cache, request, "read");
      if (!admitted.ok) return admitted.response;
      return narinfoAnswer(cache, request, admitted.bucket, hash);
    });
}

const bad = (message: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(message, { status: 400 });

function uploadSession(request: HttpServerRequest.HttpServerRequest): string | null | undefined {
  const value = request.headers[UPLOAD_SESSION_HEADER];
  if (value === undefined || value === "") return null;
  return isUploadSession(value) ? value : undefined;
}

const BAD_SESSION = `${UPLOAD_SESSION_HEADER} must be 1–64 letters, digits, '-' or '_'`;

function partsOf(body: string): readonly UploadedPart[] | null {
  let document: unknown;
  try {
    document = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  const parts = (document as { parts?: unknown } | null)?.parts;
  if (!Array.isArray(parts)) return null;
  const named: UploadedPart[] = [];
  for (const part of parts as readonly unknown[]) {
    const { index, etag } = (part ?? {}) as { index?: unknown; etag?: unknown };
    if (!Number.isSafeInteger(index) || (index as number) < 0) return null;
    if (typeof etag !== "string" || etag === "") return null;
    named.push({ index: index as number, etag });
  }
  return named;
}

function partSizeOf(body: string): number | null | undefined {
  const text = body.trim();
  if (text === "") return null;
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  const asked = (document as { partSize?: unknown } | null)?.partSize;
  if (asked === undefined || asked === null) return null;
  return Number.isSafeInteger(asked) && (asked as number) >= 1 ? (asked as number) : undefined;
}

function refused(
  cache: Cache,
  request: HttpServerRequest.HttpServerRequest,
  message: string,
  status = 400,
  detail: Record<string, unknown> = {},
): HttpServerResponse.HttpServerResponse {
  cache.log("cache.request.refused", {
    method: request.method,
    path: request.url,
    status,
    reason: message,
    ...detail,
  });
  return HttpServerResponse.text(message, { status });
}

type AskedNarinfo =
  | { readonly kind: "narinfo"; readonly hash: string }
  | { readonly kind: "unsafe"; readonly hash: string }
  | { readonly kind: "other" };

function narinfoOrMissing(name: string): AskedNarinfo {
  if (!name.endsWith(NARINFO_SUFFIX)) return { kind: "other" };
  const hash = name.slice(0, -NARINFO_SUFFIX.length);
  return isSafeStorePathHash(hash) ? { kind: "narinfo", hash } : { kind: "unsafe", hash };
}

export { CACHE_ROUTE_PATHS } from "./paths";

export function cacheRoutes(
  cache: Cache,
  urlFor: (name: string) => string = (name) => `${CACHE_MOUNT}/${name}`,
): ClaimedRoutes<ReturnType<typeof cacheLayer>> {
  return { layer: cacheLayer(cache, urlFor), paths: CACHE_ROUTE_PATHS };
}

function cacheLayer(cache: Cache, urlFor: (name: string) => string) {
  const consumerFacts = (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const name = yield* param("bucket");
      const bucket = cache.bucket(name);
      if (bucket === null) return HttpServerResponse.empty({ status: 404 });
      const verdict = cache.authorize(request.headers["authorization"], bucket, "read");
      if (!verdict.ok) {
        return HttpServerResponse.text(verdict.message, { status: verdict.status });
      }
      const url = urlFor(bucket.name);
      const facts: ConsumerFacts = {
        name: bucket.name,
        public: bucket.isPublic,
        publicKey: bucket.publicKey,
        domain: bucket.domain,
        url,
        upstreamKeys: [...bucket.upstreamKeys],
        use: useBlock({ url, publicKey: bucket.publicKey, public: bucket.isPublic, home: null }),
        command: useCommand(bucket.name),
      };
      if ((request.headers["accept"] ?? "").includes("application/json")) {
        return HttpServerResponse.jsonUnsafe(facts);
      }
      return request.method === "HEAD"
        ? HttpServerResponse.empty({ status: 200 })
        : HttpServerResponse.text(consumerPage(facts), {
            contentType: "text/html; charset=utf-8",
          });
    });

  const uploadPart = (request: HttpServerRequest.HttpServerRequest) =>
          Effect.gen(function* () {
        const file = yield* param("file");
        if (!isSafeNarFileName(file)) return refused(cache, request, `"${file}" is not a NAR file name`);
        const index = Number(yield* param("index"));
        if (!Number.isSafeInteger(index) || index < 0) {
          return refused(cache, request, `"${yield* param("index")}" is not a part index`);
        }
        const admitted = admit(cache, request, yield* param("bucket"), "write");
        if (!admitted.ok) return admitted.response;
        const session = uploadSession(request);
        if (session === undefined) return refused(cache, request, BAD_SESSION);
        const declared = Number(request.headers["content-length"] ?? "");
        if (Number.isFinite(declared) && declared > MAX_NAR_PART_BYTES) {
          return HttpServerResponse.text(
            `a part may be at most ${MAX_NAR_PART_BYTES} bytes`,
            { status: 413 },
          );
        }
        const upload = yield* Effect.promise(() =>
          cache.beginPart(admitted.bucket, file, index, MAX_NAR_PART_BYTES, session),
        );
        const written = yield* Effect.result(
          Stream.runForEach(request.stream, (chunk) =>
            Effect.promise(() => upload.write(chunk)).pipe(
              Effect.flatMap((state) =>
                state === "too-large"
                  ? Effect.fail("too-large" as const)
                  : Effect.void,
              ),
            ),
          ).pipe(Effect.andThen(Effect.promise(() => upload.commit()))),
        );
        if (written._tag === "Failure") {
          yield* Effect.promise(() => upload.discard());
          return written.failure === "too-large"
            ? HttpServerResponse.text(
                `a part may be at most ${MAX_NAR_PART_BYTES} bytes`,
                { status: 413 },
              )
            : HttpServerResponse.text("the part did not complete", { status: 400 });
        }
        return HttpServerResponse.empty({ status: 204 });
      });

  const completeParts = (request: HttpServerRequest.HttpServerRequest) =>
          Effect.gen(function* () {
        const file = yield* param("file");
        if (!isSafeNarFileName(file)) return refused(cache, request, `"${file}" is not a NAR file name`);
        const admitted = admit(cache, request, yield* param("bucket"), "write");
        if (!admitted.ok) return admitted.response;
        const total = Number(request.headers[PARTS_HEADER] ?? "");
        if (!Number.isSafeInteger(total) || total < 1) {
          return refused(cache, request, `send ${PARTS_HEADER}: the number of parts this NAR has`);
        }
        const session = uploadSession(request);
        if (session === undefined) return refused(cache, request, BAD_SESSION);
        const outcome = yield* Effect.promise(() =>
          cache.completeUpload(admitted.bucket, file, total, session),
        );
        if (!outcome.ok) {
          return HttpServerResponse.jsonUnsafe(
            { missing: outcome.missing },
            { status: 409 },
          );
        }
        return HttpServerResponse.jsonUnsafe({ parts: outcome.parts });
      });

  const bodyText = (request: HttpServerRequest.HttpServerRequest): Promise<string> =>
    new Response(Stream.toReadableStream(request.stream)).text();

  const beginUpload = (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const file = yield* param("file");
      if (!isSafeNarFileName(file)) return refused(cache, request, `"${file}" is not a NAR file name`);
      const admitted = admit(cache, request, yield* param("bucket"), "write");
      if (!admitted.ok) return admitted.response;
      const floor = partSizeOf(yield* Effect.promise(() => bodyText(request)));
      if (floor === undefined) {
        return refused(cache, request, "partSize is a whole number of bytes, at least 1");
      }
      const plan = yield* Effect.promise(() => cache.beginDirect(admitted.bucket, file, floor));
      return HttpServerResponse.jsonUnsafe(plan);
    });

  const directPart = (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const file = yield* param("file");
      if (!isSafeNarFileName(file)) return refused(cache, request, `"${file}" is not a NAR file name`);
      const index = Number(yield* param("index"));
      const upload = yield* param("upload");
      const admitted = admit(cache, request, yield* param("bucket"), "write");
      if (!admitted.ok) return admitted.response;
      const part = yield* Effect.promise(() =>
        cache.directPart(admitted.bucket, file, upload, index),
      );
      if (!part.ok) return refused(cache, request, part.message, part.status);
      return HttpServerResponse.jsonUnsafe({ url: part.url });
    });

  const completeDirect = (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const file = yield* param("file");
      if (!isSafeNarFileName(file)) return refused(cache, request, `"${file}" is not a NAR file name`);
      const admitted = admit(cache, request, yield* param("bucket"), "write");
      if (!admitted.ok) return admitted.response;
      const upload = yield* param("upload");
      const parts = partsOf(yield* Effect.promise(() => bodyText(request)));
      if (parts === null) {
        return refused(cache, request, 'send {"parts":[{"index":0,"etag":"…"}]} — the parts you uploaded');
      }
      const outcome = yield* Effect.promise(() =>
        cache.completeDirect(admitted.bucket, file, upload, parts),
      );
      if (!outcome.ok) return refused(cache, request, outcome.message, outcome.status);
      return HttpServerResponse.jsonUnsafe({ parts: outcome.parts, bytes: outcome.bytes });
    });

  return Layer.mergeAll(
    // This router normalises a trailing slash in the PATTERN, so
    // `/cache/:bucket/` and `/cache/:bucket` are the same registration (a
    // second one is a duplicate-route error).
    HttpRouter.add("GET", `${CACHE_MOUNT}/:bucket`, consumerFacts),

    HttpRouter.add("GET", `${CACHE_MOUNT}/:bucket/nix-cache-info`, (request) =>
      Effect.gen(function* () {
        const bucket = yield* param("bucket");
        const admitted = admit(cache, request, bucket, "read");
        if (!admitted.ok) return admitted.response;
        return HttpServerResponse.text(cache.cacheInfoText(admitted.bucket.name), {
          contentType: "text/plain",
        });
      }),
    ),

    /**
     * The suffix is checked here because `find-my-way` has no "param with a
     * static suffix" spelling that does not read as a parameter literally
     * named `name.narinfo`.
     */
    HttpRouter.add("GET", `${CACHE_MOUNT}/:bucket/:name`, (request) =>
      Effect.gen(function* () {
        const asked = narinfoOrMissing(yield* param("name"));
        if (asked.kind === "other") return missingRoute();
        if (asked.kind === "unsafe") {
          return refused(cache, request, `"${asked.hash}" is not a store path hash`);
        }
        const hash = asked.hash;
        const admitted = admit(cache, request, yield* param("bucket"), "read");
        if (!admitted.ok) return admitted.response;
        return narinfoAnswer(cache, request, admitted.bucket, hash);
      }),
    ),

    HttpRouter.add("GET", `${CACHE_MOUNT}/:bucket/nar/:file`, (request) =>
      Effect.gen(function* () {
        const file = yield* param("file");
        if (!isSafeNarFileName(file)) return refused(cache, request, `"${file}" is not a NAR file name`);
        const admitted = admit(cache, request, yield* param("bucket"), "read");
        if (!admitted.ok) return admitted.response;
        const source = yield* Effect.promise(() => cache.narSource(admitted.bucket, file));
        if (source === null) return HttpServerResponse.empty({ status: 404 });
        return yield* narResponse(
          cache,
          request,
          admitted.bucket.name,
          file,
          source,
          readHeaders(admitted.bucket),
        );
      }),
    ),

    HttpRouter.add("PUT", `${CACHE_MOUNT}/:bucket/nar/:file`, (request) =>
      Effect.gen(function* () {
        const file = yield* param("file");
        if (!isSafeNarFileName(file)) return refused(cache, request, `"${file}" is not a NAR file name`);
        const admitted = admit(cache, request, yield* param("bucket"), "write");
        if (!admitted.ok) return admitted.response;
        const upload = yield* Effect.promise(() => cache.beginUpload(admitted.bucket, file));
        const written = yield* Effect.exit(
          Stream.runForEach(request.stream, (chunk) =>
            Effect.promise(() => upload.write(chunk)),
          ).pipe(Effect.andThen(Effect.promise(() => upload.commit()))),
        );
        if (written._tag === "Failure") {
          yield* Effect.promise(() => upload.discard());
          return HttpServerResponse.text("the upload did not complete", { status: 400 });
        }
        return HttpServerResponse.empty({ status: 200 });
      }),
    ),

    HttpRouter.add("PUT", `${CACHE_MOUNT}/:bucket/:name`, (request) =>
      Effect.gen(function* () {
        const asked = narinfoOrMissing(yield* param("name"));
        if (asked.kind === "other") return missingRoute();
        if (asked.kind === "unsafe") {
          return refused(cache, request, `"${asked.hash}" is not a store path hash`);
        }
        const hash = asked.hash;
        const admitted = admit(cache, request, yield* param("bucket"), "write");
        if (!admitted.ok) return admitted.response;
        const outcome = yield* Effect.promise(() =>
          cache.acceptNarinfo(
            admitted.bucket,
            hash,
            Stream.toReadableStream(request.stream),
            provenanceStated(request.headers),
          ),
        );
        if (outcome.ok) return HttpServerResponse.empty({ status: 200 });
        return refused(cache, request, outcome.message, outcome.status, outcome.detail);
      }),
    ),

    HttpRouter.add("GET", "/nix-cache-info", (request) =>
      Effect.gen(function* () {
        const admitted = admitByHost(cache, request, "read");
        if (!admitted.ok) return admitted.response;
        return HttpServerResponse.text(cache.cacheInfoText(admitted.bucket.name), {
          contentType: "text/plain",
        });
      }),
    ),

    HttpRouter.add("GET", `/:hash(${HASH_PATTERN}).narinfo`, narinfoRoot(cache)),

    HttpRouter.add("GET", "/nar/:file", (request) =>
      Effect.gen(function* () {
        const file = yield* param("file");
        if (!isSafeNarFileName(file)) return refused(cache, request, `"${file}" is not a NAR file name`);
        const admitted = admitByHost(cache, request, "read");
        if (!admitted.ok) return admitted.response;
        const source = yield* Effect.promise(() => cache.narSource(admitted.bucket, file));
        if (source === null) return HttpServerResponse.empty({ status: 404 });
        return yield* narResponse(
          cache,
          request,
          admitted.bucket.name,
          file,
          source,
          readHeaders(admitted.bucket),
        );
      }),
    ),

    HttpRouter.add("PUT", "/nar/:file", (request) =>
      Effect.gen(function* () {
        const file = yield* param("file");
        if (!isSafeNarFileName(file)) return refused(cache, request, `"${file}" is not a NAR file name`);
        const admitted = admitByHost(cache, request, "write");
        if (!admitted.ok) return admitted.response;
        const upload = yield* Effect.promise(() => cache.beginUpload(admitted.bucket, file));
        const written = yield* Effect.exit(
          Stream.runForEach(request.stream, (chunk) =>
            Effect.promise(() => upload.write(chunk)),
          ).pipe(Effect.andThen(Effect.promise(() => upload.commit()))),
        );
        if (written._tag === "Failure") {
          yield* Effect.promise(() => upload.discard());
          return HttpServerResponse.text("the upload did not complete", { status: 400 });
        }
        return HttpServerResponse.empty({ status: 200 });
      }),
    ),

    HttpRouter.add("PUT", `/:hash(${HASH_PATTERN}).narinfo`, (request) =>
      Effect.gen(function* () {
        const hash = yield* param("hash");
        if (!isSafeStorePathHash(hash)) return refused(cache, request, `"${hash}" is not a store path hash`);
        const admitted = admitByHost(cache, request, "write");
        if (!admitted.ok) return admitted.response;
        const outcome = yield* Effect.promise(() =>
          cache.acceptNarinfo(
            admitted.bucket,
            hash,
            Stream.toReadableStream(request.stream),
            provenanceStated(request.headers),
          ),
        );
        if (outcome.ok) return HttpServerResponse.empty({ status: 200 });
        return refused(cache, request, outcome.message, outcome.status, outcome.detail);
      }),
    ),

    /**
     * Cloudflare — and any proxy with a body ceiling — refuses a 100 MB
     * request, so `odu cache push` splits the compressed stream into parts.
     */
    HttpRouter.add("PUT", `${PUSH_API}/buckets/:bucket/nar/:file/parts/:index`, uploadPart),
    HttpRouter.add("PUT", `${CACHE_MOUNT}/:bucket/nar/:file/parts/:index`, uploadPart),

    HttpRouter.add("POST", `${PUSH_API}/buckets/:bucket/nar/:file/complete`, completeParts),
    HttpRouter.add("POST", `${CACHE_MOUNT}/:bucket/nar/:file/complete`, completeParts),

    HttpRouter.add("POST", `${PUSH_API}/buckets/:bucket/nar/:file/upload`, beginUpload),
    HttpRouter.add("POST", `${CACHE_MOUNT}/:bucket/nar/:file/upload`, beginUpload),

    HttpRouter.add(
      "GET",
      `${PUSH_API}/buckets/:bucket/nar/:file/upload/:upload/parts/:index`,
      directPart,
    ),
    HttpRouter.add(
      "GET",
      `${CACHE_MOUNT}/:bucket/nar/:file/upload/:upload/parts/:index`,
      directPart,
    ),

    HttpRouter.add(
      "POST",
      `${PUSH_API}/buckets/:bucket/nar/:file/upload/:upload/complete`,
      completeDirect,
    ),
    HttpRouter.add(
      "POST",
      `${CACHE_MOUNT}/:bucket/nar/:file/upload/:upload/complete`,
      completeDirect,
    ),

    HttpRouter.add("POST", `${PUSH_API}/buckets/:bucket/missing`, (request) =>
      Effect.gen(function* () {
        const admitted = admit(cache, request, yield* param("bucket"), "write");
        if (!admitted.ok) return admitted.response;
        const body = yield* request.json;
        const paths = missingRequestOf(body);
        if (paths === null) {
          return refused(cache, request, 'expected {"paths": [{"path": "/nix/store/…", "sigs": […]}]}');
        }
        const whole = wholeOf(body);
        if (whole === null) {
          return refused(
            cache,
            request,
            '"whole" is true or false: true asks for every path the bucket lacks, upstream-signed ones included',
          );
        }
        const answer = cache.missing(
          admitted.bucket,
          paths,
          provenanceStated(request.headers),
          whole ? "store" : "skip",
        );
        return HttpServerResponse.jsonUnsafe({
          missing: answer.missing,
          skippedUpstream: answer.skipped,
          substituter: urlFor(admitted.bucket.name),
        });
      }),
    ),

    HttpRouter.add("POST", `${PUSH_API}/buckets/:bucket/pin`, (request) =>
      Effect.gen(function* () {
        const admitted = admit(cache, request, yield* param("bucket"), "write");
        if (!admitted.ok) return admitted.response;
        const body = yield* request.json;
        const asked = pinRequestOf(body);
        if (asked === null) {
          return refused(cache, request, 'expected {"name": "…", "paths": ["/nix/store/…"]}');
        }
        const outcome = yield* Effect.promise(() => cache.pinAs(admitted.bucket, asked));
        if (!outcome.ok) {
          return refused(
            cache,
            request,
            outcome.message,
            outcome.code === "not_permitted" ? 403 : 400,
          );
        }
        return HttpServerResponse.jsonUnsafe(outcome.value);
      }),
    ),

    HttpRouter.add("GET", `${CACHE_MOUNT}/*`, () =>
      Effect.succeed(missingRoute()),
    ),
    HttpRouter.add("GET", "/nar/*", () => Effect.succeed(missingRoute())),
    HttpRouter.add("GET", `${PUSH_API}/*`, () => Effect.succeed(missingRoute())),
  );
}

function missingRoute(): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.text("no such cache path\n", {
    status: 404,
    contentType: "text/plain; charset=utf-8",
  });
}

function param(name: string): Effect.Effect<string, never, HttpRouter.RouteContext> {
  return Effect.map(HttpRouter.params, (params) => params[name] ?? "");
}

interface MissingRequest {
  path: string;
  sigs?: readonly string[];
}

function missingRequestOf(body: unknown): MissingRequest[] | null {
  if (body === null || typeof body !== "object" || !("paths" in body)) return null;
  const paths = body.paths;
  if (!Array.isArray(paths)) return null;
  const out: MissingRequest[] = [];
  for (const entry of paths) {
    if (entry === null || typeof entry !== "object" || !("path" in entry)) return null;
    if (typeof entry.path !== "string") return null;
    if (!("sigs" in entry) || entry.sigs === undefined) {
      out.push({ path: entry.path });
      continue;
    }
    if (!Array.isArray(entry.sigs) || entry.sigs.some((sig: unknown) => typeof sig !== "string")) {
      return null;
    }
    out.push({ path: entry.path, sigs: entry.sigs as string[] });
  }
  return out;
}

function wholeOf(body: unknown): boolean | null {
  if (body === null || typeof body !== "object") return null;
  if (!("whole" in body) || body.whole === undefined) return false;
  return typeof body.whole === "boolean" ? body.whole : null;
}

function pinRequestOf(body: unknown): { name: string; paths: readonly string[] } | null {
  if (body === null || typeof body !== "object") return null;
  if (!("name" in body) || typeof body.name !== "string") return null;
  if (!("paths" in body) || !Array.isArray(body.paths)) return null;
  if (body.paths.some((path: unknown) => typeof path !== "string")) return null;
  return { name: body.name, paths: body.paths as string[] };
}
