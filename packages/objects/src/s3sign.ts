/**
 * AWS SIGNATURE V4, for the S3 requests Bun's client cannot express: Bun's
 * `S3Client` cannot send a CONDITIONAL write (`If-None-Match: *`) or USER
 * METADATA (`x-amz-meta-*`), so the writes — a single PUT, and the three calls
 * of a multipart upload — and the metadata HEAD are signed here and sent with
 * `fetch`. The payload is never hashed — `UNSIGNED-PAYLOAD` is what every S3
 * service accepts over TLS and what lets a part stream through.
 */

import { createHash, createHmac } from "node:crypto";

export interface S3Target {
  readonly endpoint: URL;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  /** An R2 custom domain (`https://cache.example.com`) bound to the same
   *  bucket. A URL with no path, query or fragment. */
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

const scopeOf = (target: S3Target, day: string): string => `${day}/${target.region}/s3/aws4_request`;

/** The query string as SigV4 canonicalises it: every pair encoded, then sorted
 *  by the ENCODED name and value. */
const canonicalQuery = (url: URL): string =>
  [...url.searchParams.entries()]
    .map(([name, value]) => [encode(name), encode(value)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");

function signature(target: S3Target, stamp: string, day: string, canonical: string): string {
  const toSign = ["AWS4-HMAC-SHA256", stamp, scopeOf(target, day), sha256Hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${target.secretAccessKey}`, day), target.region), "s3"), "aws4_request");
  return createHmac("sha256", key).update(toSign).digest("hex");
}

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
 * A URL THAT MAKES ONE REQUEST BY ITSELF, for `expiresSeconds` from `at`. The
 * signature is in the query, so whoever holds the URL sends no credential.
 * Only `host` is signed — the holder may add any header it likes, `Range`
 * above all on a GET — and the payload hash is the literal `UNSIGNED-PAYLOAD`
 * that query auth uses. `query` is the request's own parameters, signed with
 * the rest.
 */
export function presign(
  target: S3Target,
  method: string,
  key: string,
  expiresSeconds: number,
  query: Record<string, string> = {},
  at: Date = new Date(),
): URL {
  const { stamp, day } = stampOf(at);
  const url = objectUrl(target, key, {
    ...query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${target.accessKeyId}/${scopeOf(target, day)}`,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": String(Math.max(1, Math.floor(expiresSeconds))),
    "X-Amz-SignedHeaders": "host",
    ...(target.sessionToken === undefined ? {} : { "X-Amz-Security-Token": target.sessionToken }),
  });
  const canonical = [method, url.pathname, canonicalQuery(url), `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  // LAST, and not itself signed: the signature is over the other parameters.
  url.searchParams.set("X-Amz-Signature", signature(target, stamp, day, canonical));
  return url;
}

export const presignGet = (target: S3Target, key: string, expiresSeconds: number, at: Date = new Date()): URL =>
  presign(target, "GET", key, expiresSeconds, {}, at);

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
 * `accept-encoding: identity` asks for the object, NOT A RE-ENCODING OF IT:
 * an edge in front of the service — R2 sits behind Cloudflare — takes Bun's
 * own `accept-encoding` offer for a compressible content type, and the answer
 * then measures its own body rather than the object, which is what
 * `content-length` on a HEAD and `content-range` on a window are read for.
 * It goes in UNDER the signed headers, so `SignedHeaders` never names it and
 * a proxy rewriting what it asks for cannot turn a request into a SigV4
 * failure.
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
