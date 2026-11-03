/**
 * AWS SIGNATURE V4, for the S3 requests Bun's client cannot express.
 *
 * Bun's `S3Client` streams reads, ranges, lists and deletes, and it is what the
 * S3 store uses for those. It cannot send a CONDITIONAL write
 * (`If-None-Match: *`) or USER METADATA (`x-amz-meta-*`), and those two are the
 * store's promises: an object is never overwritten, and its facts are read back
 * rather than recomputed. So the writes — a single PUT, and the three calls of
 * a multipart upload — and the metadata HEAD are signed here and sent with
 * `fetch`.
 *
 * SIGNATURES ALSO TRAVEL ALONE. `presignGet` puts one in a URL's QUERY rather
 * than a header, so a reader holding no credential of this store's — a Nix
 * client odu redirected — fetches the bytes from the service itself, until the
 * URL's own expiry passes.
 *
 * This module knows WHO is asking and WHERE (endpoint, bucket, region,
 * credentials) and nothing about objects: no streaming, no ranges, no
 * multipart. The payload is never hashed — `UNSIGNED-PAYLOAD` is what every S3
 * service accepts over TLS and what lets a part stream through.
 */

import { createHash, createHmac } from "node:crypto";

/** Where a store's bucket is and who may write it. The secret never leaves
 *  this value: not logged, not stored, not printed in a refusal. */
export interface S3Target {
  /** `https://<account>.r2.cloudflarestorage.com`, `http://127.0.0.1:7070` —
   *  parsed once, where the declaration is read. */
  readonly endpoint: URL;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  /** WHERE THE WORLD READS THIS STORE FROM, when it is readable without a
   *  credential: an R2 custom domain (`https://cache.example.com`) bound to
   *  the same bucket. Never where odu signs a request — signing stays on
   *  `endpoint`, whose host is the service's own. A URL with no path, query
   *  or fragment; the keys hang under it as they do in the bucket. */
  readonly publicUrl?: URL;
}

const hmac = (key: string | Buffer, text: string): Buffer =>
  createHmac("sha256", key).update(text).digest();

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/** RFC 3986 encoding, which is what SigV4 canonicalises with — `encodeURIComponent`
 *  leaves `!'()*` alone. */
const encode = (text: string): string =>
  encodeURIComponent(text).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

/** The path-style URL of `key` in the target's bucket. Path style, because a
 *  local gateway (versitygw, Garage) has no wildcard DNS for virtual hosts, and
 *  R2 and AWS accept it. */
export function objectUrl(target: S3Target, key: string, query: Record<string, string> = {}): URL {
  const url = new URL(target.endpoint);
  // JOINED BY SEGMENT under whatever path the endpoint has: the bucket, then
  // the key's own segments, each encoded once. The empty key is the bucket.
  const base = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  const segments = key === "" ? [target.bucket] : [target.bucket, ...key.split("/")];
  url.pathname = `${base}${segments.map(encode).join("/")}`;
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url;
}

/** SigV4 spells a moment twice: `20240102T030405Z` in the signature, and the
 *  day alone in the scope and the signing key. */
const stampOf = (at: Date): { stamp: string; day: string } => {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { stamp, day: stamp.slice(0, 8) };
};

/** What a signature is good for: one day, one region, S3. */
const scopeOf = (target: S3Target, day: string): string => `${day}/${target.region}/s3/aws4_request`;

/** The query string as SigV4 canonicalises it: every pair encoded, then sorted
 *  by the ENCODED name and value. */
const canonicalQuery = (url: URL): string =>
  [...url.searchParams.entries()]
    .map(([name, value]) => [encode(name), encode(value)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");

/** The signature over one canonical request: the day's derived key (the secret
 *  itself never signs anything) over the string to sign. */
function signature(target: S3Target, stamp: string, day: string, canonical: string): string {
  const toSign = ["AWS4-HMAC-SHA256", stamp, scopeOf(target, day), sha256Hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${target.secretAccessKey}`, day), target.region), "s3"), "aws4_request");
  return createHmac("sha256", key).update(toSign).digest("hex");
}

/**
 * The headers that sign one request. `headers` are the request's own (each is
 * signed, so a metadata header or a precondition cannot be stripped in
 * transit); the answer adds `host`, the date, the payload marker and
 * `authorization`.
 */
export function signedHeaders(
  target: S3Target,
  method: string,
  url: URL,
  headers: Record<string, string>,
  at: Date = new Date(),
): Record<string, string> {
  const { stamp, day } = stampOf(at);
  const all: Record<string, string> = {
    ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value.trim()])),
    host: url.host,
    "x-amz-date": stamp,
    "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    ...(target.sessionToken === undefined ? {} : { "x-amz-security-token": target.sessionToken }),
  };
  const names = Object.keys(all).sort();
  const query = canonicalQuery(url);
  const canonical = [
    method,
    url.pathname,
    query,
    names.map((name) => `${name}:${all[name]}\n`).join(""),
    names.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  return {
    ...all,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${target.accessKeyId}/${scopeOf(target, day)}, ` +
      `SignedHeaders=${names.join(";")}, Signature=${signature(target, stamp, day, canonical)}`,
  };
}

/**
 * A URL THAT FETCHES `key` BY ITSELF, for `expiresSeconds` from `at`. The
 * signature is in the query, so the reader sends no credential and needs none:
 * the service checks the URL. Only `host` is signed — a reader may add any
 * header it likes, `Range` above all, and the payload hash is the literal
 * `UNSIGNED-PAYLOAD` that query auth uses.
 *
 * Signed against `endpoint`, never `publicUrl`: a signature covers the host it
 * names, and the host odu knows the credentials for is the service's.
 */
export function presignGet(target: S3Target, key: string, expiresSeconds: number, at: Date = new Date()): URL {
  const { stamp, day } = stampOf(at);
  const url = objectUrl(target, key, {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${target.accessKeyId}/${scopeOf(target, day)}`,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": String(Math.max(1, Math.floor(expiresSeconds))),
    "X-Amz-SignedHeaders": "host",
    ...(target.sessionToken === undefined ? {} : { "X-Amz-Security-Token": target.sessionToken }),
  });
  const canonical = ["GET", url.pathname, canonicalQuery(url), `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  // LAST, and not itself signed: the signature is over the other parameters.
  url.searchParams.set("X-Amz-Signature", signature(target, stamp, day, canonical));
  return url;
}

/** What one request carries beyond its method and key. */
export interface S3Request {
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: BodyInit;
  /** Aborts the request, and its body if it is being read. */
  signal?: AbortSignal;
}

/**
 * One signed request, sent by `send`. `body` is a stream or bytes; a stream
 * is sent with `duplex: "half"` and never buffered here.
 *
 * ASKS FOR THE OBJECT, NOT A RE-ENCODING OF IT. Bun's `fetch` offers an
 * `accept-encoding` of its own, and an edge in front of the service — R2 sits
 * behind Cloudflare — takes that offer for a compressible content type: the
 * answer then measures its own body rather than the object, which is what
 * `content-length` on a HEAD and `content-range` on a window are read for.
 * Asked here, at the one place every request is made, rather than tolerated
 * at each answer that measures something.
 *
 * NOT SIGNED, deliberately: it goes in UNDER the signed headers, so
 * `SignedHeaders` never names it and a proxy rewriting what it asks for
 * cannot turn a request into a SigV4 failure. An edge free to ignore it is
 * also free to re-encode anyway, so `s3Store`'s HEAD still reads the record
 * before the length.
 */
export function s3Fetch(
  target: S3Target,
  method: string,
  key: string,
  init: S3Request = {},
  send: typeof fetch = fetch,
): Promise<Response> {
  const url = objectUrl(target, key, init.query);
  return send(url, {
    method,
    headers: { "accept-encoding": "identity", ...signedHeaders(target, method, url, init.headers ?? {}) },
    ...(init.body === undefined ? {} : { body: init.body, duplex: "half" }),
    ...(init.signal === undefined ? {} : { signal: init.signal }),
  } as RequestInit);
}
