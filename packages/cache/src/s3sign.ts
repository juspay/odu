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
 * This module knows WHO is asking and WHERE (endpoint, bucket, region,
 * credentials) and nothing about objects: no streaming, no ranges, no
 * multipart. The payload is never hashed — `UNSIGNED-PAYLOAD` is what every S3
 * service accepts over TLS and what lets a part stream through.
 */

import { createHash, createHmac } from "node:crypto";

/** Where a store's bucket is and who may write it. The secret never leaves
 *  this value: not logged, not stored, not printed in a refusal. */
export interface S3Target {
  /** `https://<account>.r2.cloudflarestorage.com`, `http://127.0.0.1:7070`. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
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
  const base = target.endpoint.replace(/\/+$/, "");
  const path = `/${encode(target.bucket)}/${key.split("/").map(encode).join("/")}`;
  const url = new URL(`${base}${path}`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url;
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
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = stamp.slice(0, 8);
  const all: Record<string, string> = {
    ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value.trim()])),
    host: url.host,
    "x-amz-date": stamp,
    "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    ...(target.sessionToken === undefined ? {} : { "x-amz-security-token": target.sessionToken }),
  };
  const names = Object.keys(all).sort();
  const query = [...url.searchParams.entries()]
    .map(([name, value]) => [encode(name), encode(value)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonical = [
    method,
    url.pathname,
    query,
    names.map((name) => `${name}:${all[name]}\n`).join(""),
    names.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const scope = `${day}/${target.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${target.secretAccessKey}`, day), target.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return {
    ...all,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${target.accessKeyId}/${scope}, ` +
      `SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

/** One signed request. `body` is a stream or bytes; a stream is sent with
 *  `duplex: "half"` and never buffered here. */
export function s3Fetch(
  target: S3Target,
  method: string,
  key: string,
  init: {
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: BodyInit;
  } = {},
): Promise<Response> {
  const url = objectUrl(target, key, init.query);
  return fetch(url, {
    method,
    headers: signedHeaders(target, method, url, init.headers ?? {}),
    ...(init.body === undefined ? {} : { body: init.body, duplex: "half" }),
  } as RequestInit);
}
