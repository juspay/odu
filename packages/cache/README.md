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
  THE WHOLE PROTOCOL IS IN THE STORE (PLAN 2.8): the signed narinfo goes
  beside the NAR as `<bucket>/<hash>.narinfo`, and `<bucket>/nix-cache-info`
  is written when the bucket is created, so a store can answer a reader
  without odu. SQLite stays the truth — a narinfo served BY odu is still
  rendered and signed per request — and the objects are a projection of it,
  which is why the backfill may rewrite one at any time.
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

## Reads leave odu

Every byte used to cross the daemon. Three things changed that, and each is a
property of the STORE rather than of the protocol:

- **A store may publish a `publicUrl`** (`@odu/objects`' declarations, and the
  `stores` cell). A PUBLIC bucket on such a store has `readsFrom: "store"` and
  a `url` of `<publicUrl>/<bucket>`: its reads never reach the daemon, which
  may be down. Everything else is `readsFrom: "odu"` — a private bucket's
  reads stay here because only odu can ask who is asking, and a store's domain
  cannot, which is also why a private bucket does not BELONG on a store with a
  public domain: that domain serves every prefix in the S3 bucket, odu's
  authorisation or not. Both fields are on the bucket row and on
  `bucket.describe`. The operator binds the domain to the S3 bucket
  (`cf r2 buckets domains custom create <r2-bucket> --domain <host>
  --zone-id <zone>`); odu only checks it at
  mount — one `GET <publicUrl>/<bucket>/nix-cache-info` per store that has a
  public bucket, and anything but a 200 with the expected body is
  `cache.store.public.unreachable`, a logged refusal and never a boot failure.
- **A NAR on an S3 store is a `307`** to `presignGet(key, PRESIGN_SECONDS)` —
  ten minutes — with `cache-control: private, no-store` and no body. The
  method survives the hop (a `307`, so a HEAD stays a HEAD), no `Range` is
  proxied (the client re-sends it to the store, which answers the 206), and
  `cache.nar.served` carries `source: "redirect"` with `bytes: 0` because
  there is no body to observe. A disk store streams as it always did:
  `store.presignGet === undefined` is the whole test.
- **A cache that predates this is caught up at boot.** `backfillObjects()` is
  forked after the mount like the legacy migration, writes every missing
  narinfo object and `nix-cache-info`, two at a time, and is idempotent (a
  HEAD whose length matches the rendered text is a skip), so kolu's sixteen
  thousand rows cost a walk on the next restart rather than a rewrite.
  Progress is `cache.narinfo.backfill {bucket, written, remaining}`, one line
  per five hundred rows.

The three kinds of key are known everywhere one key is: GC deletes a row's
narinfo object with the row (a narinfo nobody can get a NAR for is worse than
none), the boot sweep counts all three as owned so it cannot mistake one for
an orphan, and a collection announces the store's own URLs for purging beside
odu's when the store has a public one.

## A bucket changes stores without going down

`bucket.migrate { bucket, store }` (`src/migrateStore.ts`) copies every object
of a bucket — NARs, narinfos, `nix-cache-info` — into another declared store,
two in flight, and **the bucket is served from the OLD store until the copy is
complete**. Only then does `bucket.store` flip, under the write lock a push
takes, with a last delta pass inside it so a path that landed mid-move is not
left behind; then the old copies are deleted and their URLs purged
(`cache.bucket.migrate.purge`). Flipping first would be a substituter that
404s everything until the copy caught up.

It is resumable because it is idempotent: an object already in the new store
with the same length is skipped on one HEAD, and the move's own row
(`bucket_migration`) survives a restart. The verb answers the bucket's ROW the
moment the move is recorded, and progress is `migration` on that row —
`{ to, state: "copying" | "flipping" | "deleting", copied, total, bytes }`, or
`null` when nothing is moving — written back every twenty-five objects,
because a write and a broadcast per HEAD is the storm the collection already
solved with deltas. It refuses an undeclared store, the store the bucket is
already on, a second move of the same bucket, and a non-admin.

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
