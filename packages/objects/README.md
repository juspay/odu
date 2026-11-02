# @odu/objects

Object stores: immutable bytes under opaque keys, on a local disk or in any S3-compatible service (Cloudflare R2, AWS S3, Garage, versitygw).

| | `diskObjectStore({ dir })` | `s3ObjectStore({ target })` |
| --- | --- | --- |
| Module | `src/diskStore.ts` | `src/s3Store.ts` (signed by `src/s3sign.ts`) |
| Objects at | `<dir>/objects/<key>` | `<bucket>/<key>`, path-style |
| A put onto an existing key | refused with `exists` (`link` fails on an existing name) | refused with `exists` (`If-None-Match: *`; `412` lost, `409` retried) |
| Facts (`size`, hex `sha256`) | a sidecar under `objects/.facts/` | `x-amz-meta-odu-size` / `-sha256` |
| A large put | streamed to a temp file, then linked | multipart, `partSize` (8 MiB) parts, `parallelParts` (4) at once, bounded memory |
| A read | the file from any offset, 64 KiB pulls | ranged GETs, 1 MiB windows, one prefetched; no HEAD — the first GET gives the size; a window shorter than its range fails the read |
| `link(key, file, facts)` | yes: the file becomes the object, no copy | absent: put `Bun.file(file)` instead |
| `list(prefix)` / `delete(key)` | a walk of `<dir>/objects/<prefix>`, an unlink | paged `ListObjectsV2`, a `DELETE` |
| `sweepTemp(prefix, before)` | `.tmp-*` files | `.tmp-*` keys and incomplete multipart uploads |

- **A store is a value.** Callers speak `ObjectStore` (`src/objectStore.ts`: the interface, the refusals, and what a key, a temp name and facts are, the only things the two stores share); the one capability only disk has, `link`, is an optional member, never a kind to ask about.
- **Refusals are values:** `exists` (with the kept object's facts), `facts_mismatch` (with both), `conflict` (a `409` that never resolved). An S3 object without the store's metadata is an `UnrecordedObject` error.
- **Declarations:** `parseStoreDeclarations({ file, text }, { readFile, reserved })` turns a JSON file of named S3 stores, plus each one's `AWS_ACCESS_KEY_ID=`/`AWS_SECRET_ACCESS_KEY=` credentials file, into `S3Target` values. A refusal never carries a credential.
- **Put-if-absent across processes** is the service's: AWS honours `If-None-Match` on `PutObject` and `CompleteMultipartUpload`; R2 documents it on `PutObject` only. See the `s3ObjectStore` header.

The contract suite (`test/contract.ts`) runs against both stores, the S3 one through versitygw (in the dev shell; `test/versitygw.ts`).

**A collection is `list` and `delete` and nothing else.** The cache's garbage collector walks a bucket's own prefix through this interface alone — the paths it decided to evict, and the keys no row of its own ever named — which is what makes a bucket on R2 collect exactly as one on local disk. The contract suite runs that shape against both stores, so neither can drift into needing a special case.
