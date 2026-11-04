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
import { type Cache, type NarSource } from "./cache";
import type { ByteRange, UploadedPart } from "@odu/objects";
import {
  CACHE_MOUNT,
  CACHE_ROUTE_PATHS,
  HASH_PATTERN,
  NARINFO_SUFFIX,
  PARTS_HEADER,
  PUSH_API,
  UPLOAD_SESSION_HEADER,
} from "./paths";
import { isUploadSession } from "./staging";
import type { BucketRow, Scope } from "./db";
import { isStagedFileName, isStorePathHash } from "./narinfo";
import {
  actionsBlock,
  flakeBlock,
  MAX_NAR_PART_BYTES,
  netrcBlock,
  nixConfBlock,
  nixOsBlock,
  pushBlock,
  useBlock,
  useCommand,
  type CacheBucketIdentity,
} from "./surface";


/** Count what actually crossed to the adapter, and report it once — at close,
 *  at cancellation, or at an error. A log at response-build time is intent, not
 *  evidence; the pod printed one for requests that never wrote a byte. */
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

/**
 * THE `Range` HEADER, against an object of `size` bytes: the whole object
 * (`null`), the inclusive range asked for, or `"unsatisfiable"` (416).
 */
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

/**
 * SERVE THE BYTES — ONE PATH, whichever store keeps them. A kept object answers
 * with its length and `Accept-Ranges`, and a `Range` is the route's arithmetic
 * and the store's read: a disk file read from an offset, a ranged GET on S3. The
 * store streams; nothing here buffers. Only a row whose object is not there yet
 * falls back to the old store's FIFO stream, which has no length and is logged
 * as such.
 */
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
   * THE STORE SERVES IT (PLAN 2.8). A `307` — not a `302` — because the
   * method must survive the hop: a HEAD that came back as a GET would hand a
   * client asking "is it there" a whole NAR.
   *
   * NO `Range` IS PROXIED. The client re-sends its own `Range` to the store,
   * which answers the 206 — so a resumed download is between those two and
   * odu never sees a byte of it. For the same reason the redirect itself is
   * `private, no-store` on every bucket, public or not: the URL in it carries
   * a signature that expires, and an edge that cached the redirect would hand
   * out a dead URL long after.
   *
   * The line is written HERE rather than by the body observer, because there
   * is no body to observe: `bytes: 0` is the fact 2.8 trades away.
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
      // THE ROW'S OBJECT IS GONE (a collection, perhaps, won the race): the
      // read's own first GET decides it, before any header is sent, and the
      // answer is the one a missing object always gets.
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

/** The `Host` a request arrived under, lowercased and without its port. A
 *  bucket's domain is stored that way, and the header is the only name a
 *  domain-routed request carries. */
function hostOf(request: HttpServerRequest.HttpServerRequest): string {
  const raw = (request.headers["host"] ?? "").trim().toLowerCase();
  const colon = raw.indexOf(":");
  return colon === -1 ? raw : raw.slice(0, colon);
}

/**
 * THE BUCKET A REQUEST'S `HOST` NAMES. A bucket with a domain is served at the
 * ROOT of that name — `/nix-cache-info`, `/<hash>.narinfo`, `/nar/<file>` — the
 * way every public binary cache is; no `Host` match is the path form's business.
 */
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
 * THE HEADERS A BUCKET'S READ CARRIES. A PUBLIC bucket's bytes are shared
 * cacheable; a PRIVATE one's are not, and saying so is the ROW's fact — the
 * module's nginx honours it, so one authorised read cannot become the next
 * anonymous reader's cache hit. Nginx also bypasses its cache on any request
 * that carries `Authorization`; this is the half the daemon owns.
 */
function readHeaders(bucket: BucketRow): Record<string, string> {
  return bucket.isPublic ? {} : { "cache-control": "private, no-store" };
}

/**
 * THE ONE NARINFO ANSWER, shared by the two routes that give it: a client
 * substituting from a bucket's DOMAIN asks for `/<hash>.narinfo`, one under
 * the mount asks for `/cache/<bucket>/<hash>.narinfo`, and from here down they
 * are the same request.
 *
 * IT IS ALSO THE ONE PLACE THE HIT RATE IS KNOWN, which is why the line is
 * written here rather than at either caller: `cache.narinfo.served` is what
 * `/metrics` counts `odu_cache_requests_total{kind="narinfo"}` from, and a
 * second emit site is a second chance for the two routes to disagree about
 * what a hit is.
 */
function narinfoAnswer(
  cache: Cache,
  request: HttpServerRequest.HttpServerRequest,
  bucket: BucketRow,
  hash: string,
): HttpServerResponse.HttpServerResponse {
  const text = cache.narinfoText(bucket, hash);
  cache.log("cache.narinfo.served", { bucket: bucket.name, hash, hit: text !== null });
  if (text === null) return HttpServerResponse.empty({ status: 404 });
  // A HEAD is a read: it is how a client asks "do you have this", and a cache
  // that did not count it would evict what its clients are about to fetch.
  cache.touch(bucket, hash);
  return request.method === "HEAD"
    ? HttpServerResponse.empty({ status: 200, headers: readHeaders(bucket) })
    : HttpServerResponse.text(text, {
        contentType: "text/x-nix-narinfo",
        headers: readHeaders(bucket),
      });
}

/** The two root-level narinfo routes share one body. */
function narinfoRoot(cache: Cache) {
  return (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const hash = yield* param("hash");
      if (!isStorePathHash(hash)) return refused(cache, request, `"${hash}" is not a store path hash`);
      const admitted = admitByHost(cache, request, "read");
      if (!admitted.ok) return admitted.response;
      return narinfoAnswer(cache, request, admitted.bucket, hash);
    });
}

const bad = (message: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(message, { status: 400 });

/**
 * THE UPLOAD SESSION a chunked upload's parts and join carry (`x-odu-upload`,
 * since the cache row's 2.4): the parts are that upload's own, so two clients
 * sending one NAR cannot have theirs joined together. Absent is an older
 * pusher, and keeps the shared part names; malformed (`undefined`) is refused.
 */
function uploadSession(request: HttpServerRequest.HttpServerRequest): string | null | undefined {
  const value = request.headers[UPLOAD_SESSION_HEADER];
  if (value === undefined || value === "") return null;
  return isUploadSession(value) ? value : undefined;
}

const BAD_SESSION = `${UPLOAD_SESSION_HEADER} must be 1–64 letters, digits, '-' or '_'`;

/**
 * THE PARTS A DIRECT UPLOAD SAYS IT WROTE (PLAN 2.9) — `{"parts":[{"index",
 * "etag"}]}`, or null when the document is not that.
 *
 * The ETags are the STORE's own answers to the client's PUTs, which is the
 * only thing a client could not have made up — and it would gain nothing by
 * doing so: the narinfo that follows is proved against the bytes odu reads
 * back out of the store, not against anything said here. An EMPTY list is
 * the single-object PUT, which has no parts to join.
 */
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

/**
 * THE PART SIZE A CLIENT ASKED FOR, from a `begin`'s body: a number, `null`
 * when it asked for nothing (an empty body, or a document without the field),
 * `undefined` when what it sent is not a part size. In DIRECT mode this is a
 * floor, not a ceiling: the store's own part size is the other half of it.
 */
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

/** ONE line per refused request: method, path, status and the reason. */
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

/**
 * WHAT A BUCKET PUBLISHES TO ITS CONSUMERS: the substituter URL, the key, the
 * upstream key names, and the block every face prints.
 *
 * A PUBLIC bucket's consumer facts are as public as the NARs it serves, so they
 * are answered with NO credential — that is what lets `odu cache use` work
 * before anybody has signed in, and what makes the page a cURL away. A private
 * bucket answers them only to a reader, through the same per-bucket rule the
 * protocol's reads use.
 *
 * `readsFrom` is NOT among them: the page answers at `/cache/<bucket>`, so
 * odu is self-evidently serving this request, and the one fact a consumer
 * acts on — where to substitute from — is already the `url` above, which is
 * the store's domain when a store fronts the bucket (PLAN 2.8).
 */
export interface ConsumerFacts extends Omit<CacheBucketIdentity, "readsFrom"> {
  readonly upstreamKeys: readonly string[];
  /** The `nix.conf` / `flake.nix` / netrc block, `home` unpinned: the page
   *  cannot know a reader's home, and `useBlock` says so. */
  readonly use: string;
  /** The command that prints the block in a terminal. */
  readonly command: string;
  /** The daemon's PUBLIC ORIGIN — where THIS INSTANCE is. The push's `see`
   *  link is built from it; the page's own link is attribution to the PRODUCT
   *  (`served by odu`), a fixed site, never a call to action. */
  readonly board: string;
}

/** The HTML a person reads; every block is text and is escaped here, once. */
function consumerPage(facts: ConsumerFacts): string {
  const escape = (text: string): string =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // ONE BLOCK PER THING A PERSON PASTES SOMEWHERE. netrc only when reading
  // needs a credential: a public bucket is read with no account at all.
  const blocks: ReadonlyArray<readonly [string, string]> = [
    ["nix.conf", nixConfBlock(facts)],
    ["NixOS / nix-darwin", nixOsBlock(facts)],
    ["flake.nix", flakeBlock(facts)],
    ["GitHub Actions", actionsBlock(facts)],
    ...(facts.public
      ? []
      : [["netrc", netrcBlock({ url: facts.url, home: null })] as const]),
  ];
  const block = (title: string, text: string): string =>
    `<h3>${escape(title)}</h3>
<div class="block"><button type="button" data-copy>copy</button><pre>${escape(text)}</pre></div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escape(facts.name)} — an odu bucket</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>/* NIGHT SHIFT, SPELLED OUT. This page ships no stylesheet — it is served
   at a bucket's own domain to a reader who has no board — so the design
   system's tokens are hard-coded here rather than imported. The values are
   the theme.css table of @odu/face, dark half first (dark wins a tie there
   too) and the light half under prefers-color-scheme. Colour carries STATUS
   on the board; this page has no status, so its only hue is the link's. */
:root{
  color-scheme:dark light;
  --canvas:#0a0d0c;--panel:#0d1210;--sunken:#070908;--line:#1c2420;--line-strong:#2a342f;
  --ink:#e6ede9;--ink-2:#c9d4ce;--muted:#93a39b;--quiet:#7a8982;--cyan:#3fd0de;
  --mono:"Geist Mono",ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;
  --sans:"Geist",ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}
@media (prefers-color-scheme: light){:root{
  --canvas:#f4f7f5;--panel:#ffffff;--line:#dde5e0;--line-strong:#c3d0c9;
  --ink:#10201a;--ink-2:#2b3a33;--muted:#48584f;--quiet:#5d6d66;--cyan:#0a7385;
}}
*{box-sizing:border-box}
body{max-width:52rem;margin:0 auto;padding:3rem 1.25rem 4rem;background:var(--canvas);color:var(--ink);font:0.95rem/1.6 var(--sans);-webkit-font-smoothing:antialiased}
a{color:var(--cyan)}
:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
/* The name is a string a machine chose, so it is mono — the same rule the
   board's bucket page keeps for its own title. */
h1{margin:0 0 .4rem;font:600 2rem/1.2 var(--mono);letter-spacing:-.03em;overflow-wrap:anywhere}
h2{margin:2.25rem 0 .6rem;font:600 1.05rem var(--sans);letter-spacing:-.01em}
h3{margin:1.4rem 0 .4rem;font:500 .8rem var(--mono);color:var(--muted)}
p{margin:0 0 .7rem;color:var(--muted)}
code{font:.82rem var(--mono);color:var(--ink-2);overflow-wrap:anywhere}
/* The facts a client trusts this bucket by: one panel, a hairline per row. */
dl{display:grid;grid-template-columns:max-content minmax(0,1fr);margin:1.25rem 0 0;border:1px solid var(--line);border-radius:14px;background:var(--panel);overflow:hidden}
dt{padding:.7rem 1rem;border-top:1px solid var(--line);color:var(--muted);font-size:.8rem}
dd{margin:0;padding:.7rem 1rem;border-top:1px solid var(--line);min-width:0;overflow-wrap:anywhere}
dl>dt:first-child,dl>dt:first-child+dd{border-top:0}
/* A snippet is copied, so it is never re-wrapped: it scrolls inside its own
   box and the PAGE never scrolls sideways, which is what makes this readable
   on a phone. The sunken surface stays dark in both themes — a terminal is a
   terminal. */
pre{margin:0;padding:1rem 1.1rem;background:var(--sunken);color:#c9d4ce;font:.78rem/1.7 var(--mono);overflow-x:auto;white-space:pre;scrollbar-width:thin}
.block{position:relative;margin:.4rem 0 1rem;border:1px solid var(--line);border-radius:14px;overflow:hidden}
.block pre{padding:2.7rem 1.1rem 1rem}
[data-copy]{position:absolute;top:.5rem;right:.5rem;min-height:2rem;padding:0 .7rem;border:1px solid var(--line-strong);border-radius:9px;background:var(--panel);color:var(--ink);font:500 .75rem var(--mono);cursor:pointer}
[data-copy]:hover{border-color:var(--cyan)}
.hint{font-size:.85rem}
.served{margin:2.5rem 0 0;padding-top:1rem;border-top:1px solid var(--line);color:var(--quiet);font:.78rem var(--mono)}
</style></head>
<body>
<h1>${escape(facts.name)}</h1>
<p>${facts.public ? "A public bucket." : "A private bucket — this page was answered to a reader."}</p>
<dl>
<dt>Substituter</dt><dd><code>${escape(facts.url)}</code> · <a href="${escape(
    `${facts.url.replace(/\/$/, "")}/nix-cache-info`,
  )}">nix-cache-info</a></dd>
<dt>Public key</dt><dd><code>${escape(facts.publicKey)}</code></dd>
<dt>Upstream keys</dt><dd><code>${escape(facts.upstreamKeys.join(" ") || "(none)")}</code></dd>
</dl>
<h2>Use it</h2>
${blocks.map(([title, text]) => block(title, text)).join("\n")}
<p class="hint">Or let a terminal print them: <code>${escape(facts.command)}</code></p>
<h2>Push to it</h2>
<p class="hint">A write token comes from this bucket's page on the board — an admin mints one. The push exports it where the build runs.</p>
${block(
  "push",
  pushBlock({ origin: facts.board, bucket: facts.name, token: null }),
)}
<script>
document.addEventListener("click", function (event) {
  var button = event.target.closest("[data-copy]");
  if (!button) return;
  var pre = button.parentElement.querySelector("pre");
  navigator.clipboard.writeText(pre.textContent).then(function () {
    button.textContent = "copied";
    setTimeout(function () { button.textContent = "copy"; }, 1200);
  });
});
</script>
<p class="served">served by <a href="https://odu.kolu.dev/">odu</a></p>
</body></html>
`;
}

export { CACHE_ROUTE_PATHS } from "./paths";

export function cacheRoutes(
  cache: Cache,
  /** The substituter URL a bucket publishes. The ROW knows the deployment's
   *  public origin; a route suite that does not passes the path form. */
  urlFor: (name: string) => string = (name) => `${CACHE_MOUNT}/${name}`,
  /** Where the board is, for the public page's one link. */
  boardUrl: string = "/",
): ClaimedRoutes<ReturnType<typeof cacheLayer>> {
  return { layer: cacheLayer(cache, urlFor, boardUrl), paths: CACHE_ROUTE_PATHS };
}

function cacheLayer(cache: Cache, urlFor: (name: string) => string, boardUrl: string) {
  /** The public page and its JSON form — one handler for both spellings. */
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
        use: useBlock({ url, publicKey: bucket.publicKey, home: null }),
        command: useCommand(bucket.name),
        board: boardUrl,
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

  /** The chunked upload's two verbs, on BOTH the push API's path and the
   *  bucket's path form: `odu cache push` addresses `<bucket>/nar/<file>`,
   *  which is the protocol's mount — while `/_odu/v1` is the admin API's. */
  const uploadPart = (request: HttpServerRequest.HttpServerRequest) =>
          Effect.gen(function* () {
        const file = yield* param("file");
        if (!isStagedFileName(file)) return refused(cache, request, `"${file}" is not a NAR file name`);
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
        if (!isStagedFileName(file)) return refused(cache, request, `"${file}" is not a NAR file name`);
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

  /** The request's body as text — a small JSON document, read once. Nothing
   *  here takes a NAR: those go to the store now (PLAN 2.9) or into staging
   *  as a stream, never through a buffer. */
  const bodyText = (request: HttpServerRequest.HttpServerRequest): Promise<string> =>
    new Response(Stream.toReadableStream(request.stream)).text();

  /**
   * BEGIN ONE NAR'S UPLOAD, and be told where its bytes go.
   *
   * The answer is the CACHE's, from the bucket's store: `{mode:"direct", …}`
   * with the URLs that write the store itself, or `{mode:"staged"}`, which
   * means the routes below this one. A client sends its own `--part-size` as
   * a FLOOR; an empty body asks for the store's own.
   */
  const beginUpload = (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const file = yield* param("file");
      if (!isStagedFileName(file)) return refused(cache, request, `"${file}" is not a NAR file name`);
      const admitted = admit(cache, request, yield* param("bucket"), "write");
      if (!admitted.ok) return admitted.response;
      const floor = partSizeOf(yield* Effect.promise(() => bodyText(request)));
      if (floor === undefined) {
        return refused(cache, request, "partSize is a whole number of bytes, at least 1");
      }
      const plan = yield* Effect.promise(() => cache.beginDirect(admitted.bucket, file, floor));
      return HttpServerResponse.jsonUnsafe(plan);
    });

  /** The URL that writes one part. A GET, because it changes nothing a second
   *  request would mind: the same part asked for twice is the same part. */
  const directPart = (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const file = yield* param("file");
      if (!isStagedFileName(file)) return refused(cache, request, `"${file}" is not a NAR file name`);
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

  /** The client has sent every part: join them and confirm the object. */
  const completeDirect = (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const file = yield* param("file");
      if (!isStagedFileName(file)) return refused(cache, request, `"${file}" is not a NAR file name`);
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
    /**
     * WHAT TO PASTE INTO A CLIENT — a bucket's consumer facts, with no account
     * for a public bucket.
     *
     * The CLI's "use needs no token" was only true of the SURFACE, where a door
     * refuses an anonymous connection before a public read can be answered.
     * These facts are as public as the NARs, so the protocol path answers them
     * anonymously; JSON for a terminal, a small page for `curl`.
     */
    // BOTH SPELLINGS ARE ONE ROUTE: this router normalises a trailing slash in
    // the PATTERN, so `/cache/:bucket/` and `/cache/:bucket` are the same
    // registration (a second one is a duplicate-route error), and the handler
    // answers both requests.
    HttpRouter.add("GET", `${CACHE_MOUNT}/:bucket`, consumerFacts),

    /** `nix-cache-info` under the mount. The text is the CACHE's — the three
     *  lines a client reads plus the two `Odu-` lines naming this daemon and
     *  this bucket — so the route and the object in the store say the same
     *  thing. */
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
     * `<hash>.narinfo`. One route for HEAD and GET (see the header), and the
     * suffix is checked here because `find-my-way` has no "param with a static
     * suffix" spelling that does not read as a parameter literally named
     * `name.narinfo`.
     */
    HttpRouter.add("GET", `${CACHE_MOUNT}/:bucket/:name`, (request) =>
      Effect.gen(function* () {
        const name = yield* param("name");
        // A PATH UNDER A BUCKET THAT NAMES NO PROTOCOL FILE IS THE ROW'S 404,
        // not an empty one: this route outranks the mount's wildcard, so the
        // sentence has to be said here or the wildcard never gets the request.
        if (!name.endsWith(NARINFO_SUFFIX)) return missingRoute();
        const hash = name.slice(0, -NARINFO_SUFFIX.length);
        if (!isStorePathHash(hash)) return refused(cache, request, `"${hash}" is not a store path hash`);
        const admitted = admit(cache, request, yield* param("bucket"), "read");
        if (!admitted.ok) return admitted.response;
        return narinfoAnswer(cache, request, admitted.bucket, hash);
      }),
    ),

    /** The NAR itself, streamed from the store through zstd. */
    HttpRouter.add("GET", `${CACHE_MOUNT}/:bucket/nar/:file`, (request) =>
      Effect.gen(function* () {
        const file = yield* param("file");
        if (!isStagedFileName(file)) return refused(cache, request, `"${file}" is not a NAR file name`);
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

    /**
     * A NAR upload. The body goes straight to the staging directory — never
     * through memory — and nothing is imported yet: a NAR with no narinfo names
     * no store path, and the pair is what `nix copy --from` needs.
     */
    HttpRouter.add("PUT", `${CACHE_MOUNT}/:bucket/nar/:file`, (request) =>
      Effect.gen(function* () {
        const file = yield* param("file");
        if (!isStagedFileName(file)) return refused(cache, request, `"${file}" is not a NAR file name`);
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
     * recorded, and 400 with Nix's own sentence otherwise — including a NAR
     * that was never uploaded. References are names, so there is no ordering
     * hold; a 200 for a path nobody recorded is how a push reports success for
     * bytes the cache does not have.
     */
    HttpRouter.add("PUT", `${CACHE_MOUNT}/:bucket/:name`, (request) =>
      Effect.gen(function* () {
        const name = yield* param("name");
        // A PATH UNDER A BUCKET THAT NAMES NO PROTOCOL FILE IS THE ROW'S 404,
        // not an empty one: this route outranks the mount's wildcard, so the
        // sentence has to be said here or the wildcard never gets the request.
        if (!name.endsWith(NARINFO_SUFFIX)) return missingRoute();
        const hash = name.slice(0, -NARINFO_SUFFIX.length);
        if (!isStorePathHash(hash)) return refused(cache, request, `"${hash}" is not a store path hash`);
        const admitted = admit(cache, request, yield* param("bucket"), "write");
        if (!admitted.ok) return admitted.response;
        const outcome = yield* Effect.promise(() =>
          cache.acceptNarinfo(
            admitted.bucket,
            hash,
            Stream.toReadableStream(request.stream),
          ),
        );
        if (outcome.ok) return HttpServerResponse.empty({ status: 200 });
        return refused(cache, request, outcome.message, outcome.status, outcome.detail);
      }),
    ),

    // ── A BUCKET'S OWN NAME ──────────────────────────────────────────────
    //
    // A domain is a STABLE NAME FOR A BUCKET, not a prefix: the same four
    // protocol paths sit at the root of it, and the request's `Host` — not a
    // path segment — says which bucket. The routes are registered always; a
    // request whose `Host` names no bucket is a plain 404, which is exactly
    // what a wrong name deserves.

    /** `nix-cache-info` at a bucket's domain. The same text the mount answers:
     *  `Odu-Origin` is the DAEMON's, never the domain the reader arrived on,
     *  because that name may be a store's and take no push at all. */
    HttpRouter.add("GET", "/nix-cache-info", (request) =>
      Effect.gen(function* () {
        const admitted = admitByHost(cache, request, "read");
        if (!admitted.ok) return admitted.response;
        return HttpServerResponse.text(cache.cacheInfoText(admitted.bucket.name), {
          contentType: "text/plain",
        });
      }),
    ),

    /** `<hash>.narinfo` at a bucket's domain. The hash is the route's only
     *  parameter; the suffix is static, so a shell path cannot match it. */
    HttpRouter.add("GET", `/:hash(${HASH_PATTERN}).narinfo`, narinfoRoot(cache)),

    /** The NAR at a bucket's domain, streamed from the store. */
    HttpRouter.add("GET", "/nar/:file", (request) =>
      Effect.gen(function* () {
        const file = yield* param("file");
        if (!isStagedFileName(file)) return refused(cache, request, `"${file}" is not a NAR file name`);
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

    /** A `nix copy --to https://<domain>` uploads at the root too. */
    HttpRouter.add("PUT", "/nar/:file", (request) =>
      Effect.gen(function* () {
        const file = yield* param("file");
        if (!isStagedFileName(file)) return refused(cache, request, `"${file}" is not a NAR file name`);
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
        if (!isStorePathHash(hash)) return refused(cache, request, `"${hash}" is not a store path hash`);
        const admitted = admitByHost(cache, request, "write");
        if (!admitted.ok) return admitted.response;
        const outcome = yield* Effect.promise(() =>
          cache.acceptNarinfo(admitted.bucket, hash, Stream.toReadableStream(request.stream)),
        );
        if (outcome.ok) return HttpServerResponse.empty({ status: 200 });
        return refused(cache, request, outcome.message, outcome.status, outcome.detail);
      }),
    ),

    /**
     * ONE PART of a NAR too large for a single request.
     *
     * Cloudflare — and any proxy with a body ceiling — refuses a 100 MB
     * request, so `odu cache push` splits the compressed stream into parts. A
     * part is addressed by its index, which makes a retry an overwrite: a
     * dropped request costs one part, not the path.
     */
    HttpRouter.add("PUT", `${PUSH_API}/buckets/:bucket/nar/:file/parts/:index`, uploadPart),
    HttpRouter.add("PUT", `${CACHE_MOUNT}/:bucket/nar/:file/parts/:index`, uploadPart),

    /**
     * JOIN THE PARTS — the client's count, and the server's answer. A gap is
     * `409` with the indexes: the client retries those parts and asks again.
     * The hash is still proved at the narinfo, as for every other upload.
     */
    HttpRouter.add("POST", `${PUSH_API}/buckets/:bucket/nar/:file/complete`, completeParts),
    HttpRouter.add("POST", `${CACHE_MOUNT}/:bucket/nar/:file/complete`, completeParts),

    /**
     * WHERE THIS NAR'S BYTES GO (PLAN 2.9) — asked once per path, before any
     * of them are sent, and answered from the bucket's store.
     *
     * A bucket on a store that takes its own writes answers `direct` with a
     * single-object PUT URL, a part size and this upload's handle; the parts
     * and the completion hang off that handle below. A disk-backed bucket
     * answers `staged`, which means the two routes above — and that is the
     * whole of the negotiation: no flag, no probe, no version header.
     */
    HttpRouter.add("POST", `${PUSH_API}/buckets/:bucket/nar/:file/upload`, beginUpload),
    HttpRouter.add("POST", `${CACHE_MOUNT}/:bucket/nar/:file/upload`, beginUpload),

    /** The presigned URL for one part of a direct upload. Signed here and
     *  spent at the store, so the bytes never reach this process. */
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

    /** THE PARTS ARE SENT: join them in the store and confirm the object is
     *  there. The narinfo that follows is what proves it. */
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
          return refused(cache, request, 'expected {"paths": [{"path": "/nix/store/…", "sigs": […]}]}');
        }
        const answer = cache.missing(admitted.bucket, paths);
        return HttpServerResponse.jsonUnsafe({
          missing: answer.missing,
          // Additive, and the reason `odu cache push` can print "skipped
          // upstream" as a number of its own rather than folding it into
          // "already there": the bucket is the only side that knows its
          // upstream key names.
          skippedUpstream: answer.skipped,
          // WHERE A CLIENT SUBSTITUTES THIS BUCKET — a bucket's own domain
          // when it has one, the mount path otherwise, from the SAME builder
          // the board's row and `bucket.describe` answer with. A pusher that
          // then proves its push asks THIS address, which is the one Nix will
          // ask: `<substituter>/<hash>.narinfo`.
          substituter: urlFor(admitted.bucket.name),
        });
      }),
    ),

    /**
     * PIN A CLOSURE WITH THE TOKEN THAT PUSHED IT — the one pin verb outside
     * the administrative surface, and the reason CI can keep a master pin
     * current (`.github/actions/push`'s `pin:` input).
     *
     * WRITE scope, and the rule is a capability argument rather than a
     * convenience: a write token can already keep any closure alive forever by
     * pushing it again, because a stored push renews `lastWanted`. A pin it
     * may create or re-point makes that same promise once instead of nightly;
     * it reads nothing, deletes nothing, and administers nothing. DELETING a
     * pin stays the admin surface's — that is giving up retention somebody
     * else asked for.
     *
     * Re-pointing is the whole point: the same name, the closure of today's
     * build, and yesterday's roots let go in the same statement.
     */
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
        // 403, NOT 400, when the rule refused rather than the request: the
        // token is real and may not move THIS pin, which is the difference
        // between "fix your body" and "ask an administrator".
        if (!outcome.ok) {
          return refused(
            cache,
            request,
            outcome.message,
            outcome.code === "not_permitted" ? 403 : 400,
          );
        }
        // THE PIN AS THE ROW KNOWS IT — the same shape `pin.list` answers,
        // rather than a hand-picked copy that stops following the day the
        // row learns another fact about a pin (it just learned two).
        return HttpServerResponse.jsonUnsafe(outcome.value);
      }),
    ),

    /**
     * A CLAIMED PREFIX MEANS "MINE". Anything under one of this row's paths
     * that matched no protocol file is the CACHE's 404 — text, never the
     * shell's catch-all. Without these, `…/cache/kolu/nope` met the board's
     * SPA, which is a page at a path the board never routed for and reads as
     * a broken board rather than as a missing file.
     */
    HttpRouter.add("GET", `${CACHE_MOUNT}/*`, () =>
      Effect.succeed(missingRoute()),
    ),
    HttpRouter.add("GET", "/nar/*", () => Effect.succeed(missingRoute())),
    HttpRouter.add("GET", `${PUSH_API}/*`, () => Effect.succeed(missingRoute())),
  );
}

/** The row's own 404: a sentence, not a bundle. */
function missingRoute(): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.text("no such cache path\n", {
    status: 404,
    contentType: "text/plain; charset=utf-8",
  });
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

/**
 * The pin body, parsed by hand for the same reason the `missing` body is: a
 * small frozen shape with one producer, whose refusal has to be a sentence.
 * The row checks what a pin MEANS (a name that is not blank, paths the bucket
 * actually holds); this only says the bytes are the shape they claim.
 */
function pinRequestOf(body: unknown): { name: string; paths: readonly string[] } | null {
  if (body === null || typeof body !== "object") return null;
  if (!("name" in body) || typeof body.name !== "string") return null;
  if (!("paths" in body) || !Array.isArray(body.paths)) return null;
  if (body.paths.some((path: unknown) => typeof path !== "string")) return null;
  return { name: body.name, paths: body.paths as string[] };
}
