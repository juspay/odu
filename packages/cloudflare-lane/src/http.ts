/**
 * The odu-lane Worker's runtime-free request handlers: authentication and the
 * R2 bucket as a Nix binary cache. Kept out of `worker.ts` (which needs the
 * Workers runtime for `@cloudflare/containers`) so they are unit-tested under
 * Bun against an in-memory bucket (`http.test.ts`), and typechecked with the
 * rest of odu.
 */

/** The slice of Workers' `R2Bucket` this file uses. */
export interface CacheBucket {
  get(key: string): Promise<{ body: ReadableStream; size: number; httpMetadata?: { contentType?: string } } | null>;
  head(key: string): Promise<{ size: number } | null>;
  put(key: string, body: ReadableStream | ArrayBuffer | Uint8Array, options: { httpMetadata: { contentType: string } }): Promise<unknown>;
  list(options: { cursor?: string; limit: number }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
  delete(keys: string[]): Promise<void>;
}

/** Empty the bucket — `odu cloudflare teardown` runs this first, because R2
 *  refuses to delete a bucket that still holds objects and wrangler can only
 *  delete them one by one. Bounded per call (Workers cap subrequests), so the
 *  caller repeats while `more`. */
export async function purgeCache(bucket: CacheBucket | undefined): Promise<Response> {
  if (bucket === undefined) return Response.json({ deleted: 0, more: false });
  let deleted = 0;
  for (let round = 0; round < 20; round++) {
    const page = await bucket.list({ limit: 1000 });
    if (page.objects.length === 0) return Response.json({ deleted, more: false });
    await bucket.delete(page.objects.map((o) => o.key));
    deleted += page.objects.length;
  }
  return Response.json({ deleted, more: true });
}

/** Compare without an early exit on the first differing byte. */
function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.byteLength ^ eb.byteLength;
  for (let i = 0; i < Math.max(ea.byteLength, eb.byteLength); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** Bearer (the coordinator) or Basic with the secret as password (Nix's
 *  netrc, which can only speak Basic). */
export function authorized(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ")) return constantTimeEqual(header.slice(7), secret);
  if (header.startsWith("Basic ")) {
    let decoded: string;
    try {
      decoded = atob(header.slice(6));
    } catch {
      return false;
    }
    return constantTimeEqual(decoded.slice(decoded.indexOf(":") + 1), secret);
  }
  return false;
}

/** Answered by the Worker itself: the bucket never needs to hold it, and
 *  Priority 20 puts the lane cache ahead of cache.nixos.org (40). */
const NIX_CACHE_INFO = "StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 20\n";

/** Object keys Nix writes to a binary cache: `<hash>.narinfo`, `nar/<hash>.nar.zst`,
 *  `<hash>.ls`, `log/<drv>`, `realisations/<id>.doi`. Nothing with `..`. */
const KEY = /^(?!.*\.\.)[A-Za-z0-9._+=-]+(\/[A-Za-z0-9._+=!-]+)?$/;

/** The R2 bucket as a Nix HTTP binary cache — read by containers, written by
 *  the coordinator's `nix copy --to https://…/nix-cache`. Through the Worker's
 *  own binding, so neither side needs R2 S3 credentials. Measured: a cold
 *  container substitutes the 114-path runner closure from it in 12.6 s. */
export async function nixCache(request: Request, bucket: CacheBucket | undefined, key: string): Promise<Response> {
  if (bucket === undefined) return new Response("no R2 bucket bound\n", { status: 503 });
  if (key === "nix-cache-info") {
    if (request.method === "PUT") return new Response(null, { status: 204 });
    return new Response(request.method === "HEAD" ? null : NIX_CACHE_INFO, {
      headers: { "content-type": "text/x-nix-cache-info" },
    });
  }
  if (!KEY.test(key)) return new Response("bad key\n", { status: 400 });
  switch (request.method) {
    case "GET": {
      const object = await bucket.get(key);
      if (object === null) return new Response("not found\n", { status: 404 });
      return new Response(object.body, {
        headers: {
          "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
          "content-length": String(object.size),
        },
      });
    }
    case "HEAD": {
      const object = await bucket.head(key);
      if (object === null) return new Response(null, { status: 404 });
      return new Response(null, { headers: { "content-length": String(object.size) } });
    }
    case "PUT": {
      // R2 streams a body only when its length is known up front.
      if (request.headers.get("content-length") === null) {
        return new Response("content-length required\n", { status: 411 });
      }
      const contentType = request.headers.get("content-type") ?? "application/octet-stream";
      await bucket.put(key, request.body ?? new Uint8Array(), { httpMetadata: { contentType } });
      return new Response(null, { status: 201 });
    }
    default:
      return new Response("method not allowed\n", { status: 405 });
  }
}
