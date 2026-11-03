# @odu/objects

Object stores: immutable bytes under opaque keys, on a local disk or in any S3-compatible service (Cloudflare R2, AWS S3, Garage, versitygw).

| | `diskObjectStore({ dir })` | `s3ObjectStore({ target })` |
| --- | --- | --- |
| Module | `src/diskStore.ts` | `src/s3Store.ts` (signed by `src/s3sign.ts`) |
| Objects at | `<dir>/objects/<key>` | `<bucket>/<key>`, path-style |
| A put onto an existing key | refused with `exists` (`link` fails on an existing name) | refused with `exists` (`If-None-Match: *`; `412` lost, `409` retried) |
| Facts (`size`, hex `sha256`) | a sidecar under `objects/.facts/` | `x-amz-meta-odu-size` / `-sha256`; the SIZE is the metadata's |
| A large put | streamed to a temp file, then linked | multipart, `partSize` (8 MiB) parts, `parallelParts` (4) at once, bounded memory |
| A read | the file from any offset, 64 KiB pulls | ranged GETs, 1 MiB windows, one prefetched; no HEAD — the first GET gives the size; a window shorter than its range fails the read |
| `link(key, file, facts)` | yes: the file becomes the object, no copy | absent: put `Bun.file(file)` instead |
| `put(key, body, facts?, options?)` options | accepted and ignored: a file has no response of its own | `content-type` / `cache-control` kept with the object, on the `PUT` and on the `CreateMultipartUpload` that makes it |
| `presignGet(key, seconds)` | absent: these objects are files odu reads itself | yes: a query-signed URL (`X-Amz-Signature`, `host` alone signed, `UNSIGNED-PAYLOAD`) |
| `list(prefix)` / `delete(key)` | a walk of `<dir>/objects/<prefix>`, an unlink | paged `ListObjectsV2`, a `DELETE` |
| `sweepTemp(prefix, before)` | `.tmp-*` files | `.tmp-*` keys and incomplete multipart uploads |

- **A store is a value.** Callers speak `ObjectStore` (`src/objectStore.ts`: the interface, the refusals, and what a key, a temp name and facts are, the only things the two stores share); a capability only one kind has — `link` on disk, `presignGet` on S3 — is an optional member, never a kind to ask about. `store.presignGet === undefined` is how a caller asks whether a reader can be sent to the store instead of served.
- **A URL a reader may hold.** `presignGet(key, expiresSeconds)` answers a URL that fetches the object for that long, carrying its own authority: whoever holds it needs no credential, may send a `Range`, and gets nothing once it expires. Signed against the target's `endpoint`, never its `publicUrl` — a signature covers the host it names.
- **`PutOptions`** (`contentType`, `cacheControl`) are what a READER of the object is told, not facts: nothing reads them back and they never decide a put. The cache writes a NAR with `public, max-age=31536000, immutable`; a store with no responses of its own drops them.
- **Refusals are values:** `exists` (with the kept object's facts), `facts_mismatch` (with both), `conflict` (a `409` that never resolved). An S3 object without the store's metadata is an `UnrecordedObject` error, as is one whose bytes no longer measure the size it recorded.
- **An answer may not measure the object.** Every signed request asks for `accept-encoding: identity` (unsigned, so no proxy rewriting it can break a signature), because an intermediary that re-encodes a response makes its `content-length` a fact about its own body. An edge free to ignore that ask is free to re-encode anyway, so a HEAD reads the record first and cross-checks it only against a length that measured the object.
- **Declarations:** `parseStoreDeclarations({ file, text }, { readFile, reserved })` turns a JSON file of named S3 stores, plus each one's `AWS_ACCESS_KEY_ID=`/`AWS_SECRET_ACCESS_KEY=` credentials file, into `S3Target` values. A refusal never carries a credential. A store may declare `publicUrl` — the host the WORLD reads its objects from, an R2 custom domain bound to the same bucket — and it is a host alone: an `http(s)` URL with no path, query or fragment, because the keys hang under it exactly as they do in the bucket. Anything else is a `bad_store` refusal naming the reason.
- **Put-if-absent across processes** is the service's: AWS honours `If-None-Match` on `PutObject` and `CompleteMultipartUpload`; R2 documents it on `PutObject` only. See the `s3ObjectStore` header.

The contract suite (`test/contract.ts`) runs against both stores, the S3 one through versitygw (in the dev shell; `test/versitygw.ts`).

**A collection is `list` and `delete` and nothing else.** The cache's garbage collector walks a bucket's own prefix through this interface alone — the paths it decided to evict, and the keys no row of its own ever named — which is what makes a bucket on R2 collect exactly as one on local disk. The contract suite runs that shape against both stores, so neither can drift into needing a special case.
