# @odu/cache

**A Nix binary cache.** The standard substituter protocol, one bucket per cache,
narinfos re-signed on ingest with the bucket's own ed25519 key, hashed opaque
tokens with scope and expiry, garbage collection that cannot delete a closure
something still holds, and a row on odu's board.

Part of the odu repo — `"@odu/cache": "workspace:*"`.

## Four doors, and they are four graphs

| door | what it is | browser-safe |
| --- | --- | --- |
| `./surface` | the CONTRACT: a bucket's shape, the verbs that administer it, `CACHE_CONTRACT_VERSION`, the tagged refusal, and the expose map both the terminal and an agent read | ✅ |
| `./server` | implements it — a bucket's rows published as they move, and every `url` built from the origin the row was constructed with | ❌ |
| `./cli` | `odu cache …`, the argv face: `create`, `list`, `use`, `token`, `login`, `push`, `pin`, `gc`, `stats` | ❌ |
| `./face` | the board's Cache view | ✅ (draws) |

Behind them, for the two consumers that need them: `./cache` (the engine: the
repository, the blob store, signing, GC — what the host's cache row
constructs), `./routes` (the protocol, as one `HttpRouter` layer), `./paths`
(where it is mounted) and `./push` (the client of the cache's own HTTP API, which
is what `odu cache push` is from a machine that has neither a daemon nor a
database).

## The wall this package is

```
@odu/cache  ─→  nothing of odu
```

The BOTTOM of odu's graph: nothing above it may appear below it, and
`src/closure.test.ts` refuses `@odu/service`, `@odu/execution`, `@odu/cli`,
`@odu/run-history` and `@odu/service-client` by name. A cache that could reach
the coordinator would be a second way to start a run; one that reached the
catalog a second history.

**It reads no environment** — the state root, the root token and the store URI
arrive as arguments, because the one variable that must never be found by
accident is a root token. The single exception is `./cli`, which is a process
and therefore has an environment: which token to present, and where `~` is, are
its caller's facts, not the engine's.

**It is a row, and PR 1.5 is why it has a surface at all.** A bucket used to be
spelled three times — this package's `BucketFacts`, `@odu/service`'s
`CacheAdmin` port, and the CI surface's `CacheBucketSchema` — with the service
building a `url` from a `publicOrigin` it had been told. The cache owns its
contract now: `@odu/host` mounts this surface as a SIBLING of the runs, at the
key `cache`, and the names that fact produces are `surface/cache/bucket/create`
on the wire and `cache_bucket_create` to an agent.

## Three things that are the protocol's, not ours

- **Narinfo signatures are computed at READ time.** A stored signature would
  silently survive a rotated key; one ed25519 sign per narinfo GET is nothing.
  The client's own signatures are kept beside the server's.
- **Blobs are the machine's Nix store.** `put` imports a NAR through the daemon,
  `get` streams `nix store dump-path` through zstd, `delete` drops odu's gcroot
  and runs `nix-store --delete`. Dedup across buckets is by store path, for
  free, and there is no second copy on a single machine.
- **GC is the niks3 model.** An object is evicted only when retention has
  expired, nothing retained in the bucket references it, and no pin holds it —
  a path with no retaining bucket loses its root and is deleted from the store.
  This is the direct answer to the failure chutney shipped: 669 GB of S3 and
  46 GB of Postgres with growth unbounded and GC off.

## The row a board follows

`buckets` is a collection with `deltas`: one row per bucket, carrying the
bucket's public facts plus `lastPush` and `hits`. It is PUBLISHED, never polled
— the cache knows when a push lands, when a bucket appears, when a closure is
pinned or collected, and when reads accumulate. Reads are folded in at most once
a second, because a bucket being fetched from is a counter moving thousands of
times a minute and a publish per read would be a broadcast storm dressed as
freshness.

## Docs

- The place it is served: [`packages/host/README.md`](../host/README.md)
- The product it is half of: [`PLAN.md`](../../PLAN.md)
