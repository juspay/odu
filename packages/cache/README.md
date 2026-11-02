# @odu/cache

**A Nix binary cache.** The standard substituter protocol, one bucket per cache,
narinfos re-signed on ingest with the bucket's own ed25519 key, hashed opaque
tokens with scope and expiry, garbage collection that cannot delete a closure
something still holds, and a row on odu's board.

Part of the odu repo — `"@odu/cache": "workspace:*"`.

## Four doors, and they are four graphs

| door | what it is | browser-safe |
| --- | --- | --- |
| `./surface` | the CONTRACT: a bucket's shape, the verbs that administer it, the tagged refusal, `useBlock`, and the expose map both the terminal and an agent read | ✅ |
| `./server` | implements it and exports `cacheRow` — the plugin the daemon mounts, which mounts ITSELF on the runs' bundle and closes its own database | ❌ |
| `./cli` | `odu cache …`, the argv face: `use`, `login`, `push`; the administering verbs are the board and `odu surface cache <verb>` (`bucket_create`, `bucket_list`, `token_mint`, `pin_create`, `gc_run`, `stats_read`, …) | ❌ |
| `./face` | the board's Cache view | ✅ (draws) |

That is the whole package: the engine, the protocol route and the mount path are
its own business rather than doors, because the row that uses them is inside it.
One extra export sits apart: `./push`, which is not a door ONTO this package but
a CLIENT of the cache's own HTTP API — the reason `odu cache push` runs on a
machine with no daemon and no database.

## The wall this package is

```
@odu/cache  ─→  @odu/cordis  ─→  nothing of odu
```

The BOTTOM of odu's graph: nothing above it may appear below it, and
`src/closure.test.ts` refuses `@odu/service`, `@odu/execution`, `@odu/cli`,
`@odu/run-history` and `@odu/service-client` by name. A cache that could reach
the coordinator would be a second way to start a run; one that reached the
catalog a second history. The one `@odu/*` it does name is `@odu/cordis` — the
service tags and composition helpers the daemon and its rows share, which name
no row either — and it names it because this package IS a row: `./server` is a
`definePlugin`, and the tags are how it says what it needs.

**It reads no environment** — the state root, the root token and the migration
source arrive as arguments, because the one variable that must never be found by
accident is a root token. The declared stores are read once by
`readCacheStores`, which the HOST calls at boot and hands to `cacheRowRecord` —
the row owns the reader; the host only passes what it read. The single exception is `./cli`, which is a process
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
- **Blobs are the compressed NAR the pusher sent.** An `ObjectStore`
  (`@odu/objects`, which knows keys and bytes and nothing of Nix) keeps
  `<bucket>/nar/<narHash>.<ext>` — the disk store under `<state>/cache/objects`,
  an S3 store in its bucket — and each bucket names its store (`local` or one
  declared in `$ODU_OBJECT_STORES`). A put is put-if-absent, a read takes a
  range, and the facts written at put are read back. Nothing is imported, and
  references are names in the narinfo. Dedup is per NarHash per bucket, and a
  twin row shares the object until GC deletes it with the last row.
- **GC is the niks3 model.** An object is evicted only when retention has
  expired, nothing retained in the bucket references it, and no pin holds it.
  This is the direct answer to the failure chutney shipped: 669 GB of S3 and
  46 GB of Postgres with growth unbounded and GC off.

## What a bucket keeps, and when it stops

- **Retention counts from `lastWanted`, not from the last read.** A path's clock
  is renewed by a stored push, and by a `missing` query that named it — whether
  it was missing or already there. A read never moves it; a read moves `hits`
  and nothing else. Reads are leaving odu, so a clock a read wound would make
  the busiest paths in the cache the first to look idle. The default is ninety
  days (`DEFAULT_RETENTION_DAYS`), `bucket.create`'s `retentionDays` is
  optional, and a bucket changes its mind with `bucket.retention`; zero means
  "keep only what something references or a pin holds".
- **A pin is a name over a closure.** `pin.create` resolves the closure at pin
  time and re-points a pin of the same name, so yesterday's roots let go in the
  same statement. GC then walks the bucket's own references from those roots,
  which is how a path pushed later under a pinned root is held too. `pin.list`
  says what each pin holds and `pin.delete` lets one go.
- **The dry run is what a person reads before the button.** `gc.plan` answers
  the same decision without doing it: the whole count and the whole byte total,
  plus the first `GC_PREVIEW_PATHS` paths oldest want first, so the top line is
  the first to go. It is a READ — an agent may ask it without a confirmation.
- **The row collects itself, daily.** `schedule()` runs a collection of every
  bucket every `GC_EVERY_MS` as a CHAIN OF TIMEOUTS rather than an interval: a
  bucket whose collection outlasts its own period never gets a second one
  started on top of it, because each pass schedules the next when it ends. A
  scheduled pass has nobody to refuse, so whatever it hit is one
  `cache.gc.failed` line and the next pass is still scheduled. `gc.run` is that
  same collection asked for sooner.
- **The report names orphans.** A pass lists the bucket's own prefix in its
  store and deletes object keys no row named — a put whose record never landed.
  They are bytes nothing else can enumerate, so the pass that sweeps them is
  the one moment they are visible (`orphans` on the report).
- **Collecting is `list` and `delete` and nothing else.** GC speaks only
  `ObjectStore`, so a bucket on R2 collects exactly as one on local disk —
  `@odu/objects`' contract suite and `src/gcStores.test.ts` run the same cases
  against disk AND a real S3 service.
- **What left is announced, not purged here.** The deleted URLs go out through
  `CachePurge` (`@odu/cordis`): the cloudflare row purges them at the CDN, and
  with nobody registered `announce` is a no-op — no CDN, no purge, no refusal.
  This package never names Cloudflare.
- **A write token may pin — its own pins.** `POST /_odu/v1/buckets/<bucket>/pin`
  with `{"name": "…", "paths": ["/nix/store/…"]}` — what `odu cache push --pin
  NAME` and the repository's push action use. The scope rule is a capability
  argument rather than a convenience: a write token can already keep a closure
  alive forever by pushing it again, since a stored push renews `lastWanted`,
  so a pin it creates grants it no retention it lacked — it makes the same
  promise once instead of nightly.
  RE-POINTING IS RELEASING, though, so the line is drawn by who made the pin
  (`createdBy`, on the row and on `pin.list`): a write token may re-point a
  pin a write token made, and never an administrator's — a leaked CI token or
  a typo in a workflow's `pin:` must not drop `release-1.0`. Write tokens of
  one bucket are peers in this, as they already are in pushing to it.
  DELETING a pin stays the admin surface's either way.

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
