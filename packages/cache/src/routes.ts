/**
 * THE PROTOCOL — the standard Nix HTTP binary cache, as one `HttpRouter` layer.
 *
 * Merged beside the shell exactly like `/mcp` (`packages/host/src/mcpRoute.ts`,
 * and see the comment there on why the return type is INFERRED): `HttpRouter`
 * ranks by specificity, so these literal and prefixed paths beat the shell's
 * `GET /*` catch-all whichever way round they go in.
 *
 * **The cache owns every two-segment GET on the listener.** `GET /:bucket/:name`
 * is the narinfo route, and a bucket named `sw.js` would shadow the shell's own
 * `/sw.js` — which it cannot, because a bucket name is a lowercase label and
 * the shell's fixed paths are not, and because `/:bucket/nix-cache-info` and
 * `/:bucket/nar/:file` rank above it. The one path this file DOES claim is any
 * two-segment GET, so a future fixed asset with a two-segment path belongs
 * above this layer, not beside it. `routes.test.ts` pins the shell's three.
 *
 * **Nothing here holds a NAR.** A read hands the socket
 * `HttpServerResponse.stream` of the store's own pipeline; an upload hands the
 * store the request's body stream. The two places a multi-gigabyte NAR could be
 * materialised are exactly the two places that do not.
 *
 * **Every route parameter is validated before it reaches the filesystem.** The
 * router DECODES `%2F`, so a `:name` of `..%2F..%2Fx` would otherwise be a path
 * segment in a `join()`. A narinfo hash is 32 characters of Nix base32 and a NAR
 * file name is a plain file name; anything else is a 400 and nothing is
 * written.
 *
 * **Authentication is per request and per bucket.** A public bucket reads
 * without a token; a private one needs read scope; a write always needs write
 * scope. `Authorization: Bearer` and HTTP Basic are both accepted — Basic with
 * any username and the token as the password is what `nix copy --to` sends
 * through curl, so a cache that spoke only Bearer would be a cache no Nix
 * client could write to. An anonymous read of a PRIVATE bucket is a 404, not a
 * 401: "you need a token" confirms the bucket exists.
 *
 * **`HEAD` is served by the `GET` route.** `find-my-way` falls back from HEAD
 * to GET, and `HttpRouter.add` cannot even register a HEAD, so the narinfo
 * handler branches on the method and answers an empty 200: the touch that makes
 * a HEAD count as a read still happens, and no body is generated for a client
 * that will not read it.
 */

import { Effect, Layer, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { ClaimedRoutes } from "@odu/cordis/services";
import { type Cache } from "./cache";
import { CACHE_MOUNT } from "./paths";
import { NIX_CACHE_INFO } from "./staging";
import type { BucketRow, Scope } from "./db";
import { isStagedFileName, isStorePathHash } from "./narinfo";

/** A bucket by name, and a credential that may do `need` with it — or the
 *  response that says why not. Every protocol route starts here, so "unknown
 *  bucket is a 404 everywhere" is one line rather than six. */
function admit(
  cache: Cache,
  request: HttpServerRequest.HttpServerRequest,
  name: string,
  need: Scope,
): { ok: true; bucket: BucketRow } | { ok: false; response: HttpServerResponse.HttpServerResponse } {
  const bucket = cache.bucket(name);
  if (bucket === null) {
    return { ok: false, response: HttpServerResponse.empty({ status: 404 }) };
  }
  const verdict = cache.authorize(request.headers["authorization"], bucket, need);
  if (!verdict.ok) {
    return {
      ok: false,
      response: HttpServerResponse.text(verdict.message, { status: verdict.status }),
    };
  }
  return { ok: true, bucket };
}

const NARINFO_SUFFIX = ".narinfo";

const bad = (message: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(message, { status: 400 });

/** Where the push API lives — odu's own, beside the Nix protocol's mount. */
const PUSH_API = "/_odu/v1";

/**
 * THE PATHS THESE ROUTES ANSWER, beside the routes: the Nix protocol under
 * {@link CACHE_MOUNT} and the push API under {@link PUSH_API}. Both carry their
 * own per-bucket credentials, so the door gate lets an anonymous request
 * through to them — and a route added below outside both prefixes is caught by
 * `@odu/host`'s `reserved.test.ts`, which records what this layer registers.
 */
export const CACHE_ROUTE_PATHS: ReadonlyArray<string> = [`${CACHE_MOUNT}/*`, `${PUSH_API}/*`];

export function cacheRoutes(cache: Cache): ClaimedRoutes<ReturnType<typeof cacheLayer>> {
  return { layer: cacheLayer(cache), paths: CACHE_ROUTE_PATHS };
}

function cacheLayer(cache: Cache) {
  return Layer.mergeAll(
    /** `nix-cache-info` — the three lines a client reads before anything else. */
    HttpRouter.add("GET", `${CACHE_MOUNT}/:bucket/nix-cache-info`, (request) =>
      Effect.gen(function* () {
        const bucket = yield* param("bucket");
        const admitted = admit(cache, request, bucket, "read");
        if (!admitted.ok) return admitted.response;
        return HttpServerResponse.text(NIX_CACHE_INFO, { contentType: "text/plain" });
      }),
    ),

    /**
     * `<hash>.narinfo`. One route for HEAD and GET (see the header), and the
     * suffix is checked here because `find-my-way` has no "param with a static
     * suffix" spelling that does not read as a parameter literally named
     * `name.narinfo`.
     */
    HttpRouter.add("GET", `${CACHE_MOUNT}/:bucket/:name`, (request) =>
      Effect.gen(function* () {
        const name = yield* param("name");
        if (!name.endsWith(NARINFO_SUFFIX)) return HttpServerResponse.empty({ status: 404 });
        const hash = name.slice(0, -NARINFO_SUFFIX.length);
        if (!isStorePathHash(hash)) return bad(`"${hash}" is not a store path hash`);
        const admitted = admit(cache, request, yield* param("bucket"), "read");
        if (!admitted.ok) return admitted.response;
        const text = cache.narinfoText(admitted.bucket, hash);
        if (text === null) return HttpServerResponse.empty({ status: 404 });
        // A HEAD is a read: it is how a client asks "do you have this", and a
        // cache that did not count it would evict what its clients are about to
        // fetch.
        cache.touch(admitted.bucket, hash);
        return request.method === "HEAD"
          ? HttpServerResponse.empty({ status: 200 })
          : HttpServerResponse.text(text, { contentType: "text/x-nix-narinfo" });
      }),
    ),

    /** The NAR itself, streamed from the store through zstd. */
    HttpRouter.add("GET", `${CACHE_MOUNT}/:bucket/nar/:file`, (request) =>
      Effect.gen(function* () {
        const file = yield* param("file");
        if (!isStagedFileName(file)) return bad(`"${file}" is not a NAR file name`);
        const admitted = admit(cache, request, yield* param("bucket"), "read");
        if (!admitted.ok) return admitted.response;
        const stream = yield* Effect.promise(() => cache.narStream(admitted.bucket, file));
        if (stream === null) return HttpServerResponse.empty({ status: 404 });
        return HttpServerResponse.stream(
          Stream.fromReadableStream({ evaluate: () => stream, onError: (err) => err }),
          { contentType: "application/x-nix-nar" },
        );
      }),
    ),

    /**
     * A NAR upload. The body goes straight to the staging directory — never
     * through memory — and nothing is imported yet: a NAR with no narinfo names
     * no store path, and the pair is what `nix copy --from` needs.
     */
    HttpRouter.add("PUT", `${CACHE_MOUNT}/:bucket/nar/:file`, (request) =>
      Effect.gen(function* () {
        const file = yield* param("file");
        if (!isStagedFileName(file)) return bad(`"${file}" is not a NAR file name`);
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

    /**
     * The narinfo that completes an upload.
     *
     * The answer is the OUTCOME, not an acknowledgement: 200 when the path is
     * recorded, 202 when it is waiting on a reference that has not arrived (an
     * ordering fact — `nix copy --to` may send a closure in any order), and 400
     * with Nix's own sentence for everything else. A 200 for a path nobody
     * recorded is how a push reports success for bytes the cache does not have.
     */
    HttpRouter.add("PUT", `${CACHE_MOUNT}/:bucket/:name`, (request) =>
      Effect.gen(function* () {
        const name = yield* param("name");
        if (!name.endsWith(NARINFO_SUFFIX)) return HttpServerResponse.empty({ status: 404 });
        const hash = name.slice(0, -NARINFO_SUFFIX.length);
        if (!isStorePathHash(hash)) return bad(`"${hash}" is not a store path hash`);
        const admitted = admit(cache, request, yield* param("bucket"), "write");
        if (!admitted.ok) return admitted.response;
        const outcome = yield* Effect.promise(() =>
          cache.acceptNarinfo(
            admitted.bucket,
            hash,
            Stream.toReadableStream(request.stream),
          ),
        );
        if (outcome.ok) {
          return outcome.status === 200
            ? HttpServerResponse.empty({ status: 200 })
            : HttpServerResponse.text(
                `waiting on ${outcome.missing.join(", ")} — upload them and repeat this narinfo`,
                { status: 202 },
              );
        }
        return HttpServerResponse.text(outcome.message, { status: outcome.status });
      }),
    ),

    /**
     * The batched "which of these are you missing" query. Not part of the Nix
     * protocol — it is what makes `odu cache push` cheaper than `nix copy`,
     * which probes one path at a time. It also drops paths signed by an
     * upstream key, which is how nixpkgs stays out of a bucket.
     */
    HttpRouter.add("POST", `${PUSH_API}/buckets/:bucket/missing`, (request) =>
      Effect.gen(function* () {
        const admitted = admit(cache, request, yield* param("bucket"), "write");
        if (!admitted.ok) return admitted.response;
        const body = yield* request.json;
        const paths = missingRequestOf(body);
        if (paths === null) {
          return bad('expected {"paths": [{"path": "/nix/store/…", "sigs": […]}]}');
        }
        const answer = cache.missing(admitted.bucket, paths);
        return HttpServerResponse.jsonUnsafe({
          missing: answer.missing,
          // Additive, and the reason `odu cache push` can print "skipped
          // upstream" as a number of its own rather than folding it into
          // "already there": the bucket is the only side that knows its
          // upstream key names.
          skippedUpstream: answer.skipped,
        });
      }),
    ),
  );
}

/** One route parameter, as an Effect so it can be yielded beside the handler's
 *  other effects. A route that matched always has its parameters. */
function param(name: string): Effect.Effect<string, never, HttpRouter.RouteContext> {
  return Effect.map(HttpRouter.params, (params) => params[name] ?? "");
}

interface MissingRequest {
  path: string;
  sigs?: readonly string[];
}

/**
 * Parse the `missing` body by hand rather than with a schema: it is a small,
 * frozen shape that `odu cache push` is the only producer of, and a decode
 * failure has to be a 400 with a sentence rather than a schema error. Narrowed
 * with `in` and `typeof` rather than cast, because this is somebody else's
 * bytes.
 */
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
