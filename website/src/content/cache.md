# Nix binary cache

`odu web` also serves Nix binary caches. The same loopback service that runs CI answers the standard Nix HTTP binary cache protocol, so every Nix client works unchanged.

A bucket is one cache: one substituter URL under the service's origin and one ed25519 public key. The server generates the keypair and signs each narinfo on ingest; a pusher never holds a signing key. Client signatures are kept. By default the cache binds loopback, like the board: `$ODU_WEB_ORIGIN` is the address it listens on, and the NixOS module puts nginx in front of it — proxying the cache's protocol paths only, unless [server mode](../docs/#server-mode) is configured, where the board and `/mcp` are behind the same door. The cache keeps the compressed NAR a pusher sent (like Cachix and Attic) and no Nix store of its own — on the server's disk, or in any S3-compatible bucket ([Keep a bucket on S3](#keep-a-bucket-on-s3)); see [Where the data lives](#where-the-data-lives).

## Create a bucket

```sh
odu surface cache bucket_create --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","name":"main","public":true,"retentionDays":30}' --json
```

The CLI does not create buckets: a bucket is made on the board's Cache view — the **Create bucket** form, with the same upstream switch — or with the API verb above, whose input is `packages/cache/src/surface.ts`'s `bucket_create` (`upstreamKeys: []` is the old `--no-upstream`; `store` names a declared S3 store). `bucket_create` answers the substituter URL and the bucket's public key. Behind a proxy that URL is the address you published the service at, not the loopback one — `$ODU_PUBLIC_ORIGIN`, which the NixOS module derives for you. `odu cache use main` prints the same as two Nix settings, ready for `nix.conf` — and needs no token at all, because a bucket's URL and public key are what it publishes to every client that talks to it. On a server with a door that is a PROTOCOL read, not a session: `GET /cache/<bucket>/` answers a public bucket's facts with no account (a small page for `curl`, add `Accept: application/json` for a terminal). A private bucket's facts need a reader, and `odu cache use` says so:

## Use it

The bucket's page shows these as separate, titled blocks — one per thing you paste somewhere. Trust the key, then a build substitutes from the bucket instead of the network.

`nix.conf`:

```sh
extra-substituters = http://127.0.0.1:18440/cache/main
extra-trusted-public-keys = main-1:<public-key>
```

NixOS / nix-darwin:

```nix
nix.settings = {
  extra-substituters = [ "http://127.0.0.1:18440/cache/main" ];
  extra-trusted-public-keys = [ "main-1:<public-key>" ];
};
```

`flake.nix`:

```nix
{
  nixConfig = {
    extra-substituters = [ "http://127.0.0.1:18440/cache/main" ];
    extra-trusted-public-keys = [ "main-1:<public-key>" ];
  };
}
```

GitHub Actions — inside the step that installs Nix:

```yaml
extra_nix_config: |
  extra-substituters = http://127.0.0.1:18440/cache/main
  extra-trusted-public-keys = main-1:<public-key>
```

A **private** bucket's page also carries the netrc block, because reading it needs a credential:

```sh
# netrc — an absolute path, no ~
netrc-file = <home>/.netrc
machine 127.0.0.1:18440 password <your-read-token>
```

Or let a terminal print them: `odu cache use main`.

## Tokens

```sh
odu surface cache token_mint --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","bucket":"main","scope":"write"}' --json
odu surface cache token_mint --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","bucket":"main","bucketGlob":"team-*","scope":"write"}' --json
```

On the board: a bucket page's **Tokens** section mints one (write or read scope), lists them, and revokes one. The token is printed once; the server keeps only its hash, in the database described under [Where the data lives](#where-the-data-lives). A token carries a bucket glob, a scope (`read`, `write` or `admin`), an expiry, and its last use. The board's forms default to **ninety days**, with **never** a visible choice; the verb takes `expiresDays` and an absent one is the explicit never — the shape a CI secret wants. An expired token's refusal names the date it expired. Revoke one without touching the rest:

```sh
odu surface cache token_list --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","bucket":"main"}' --json
odu surface cache token_revoke --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","id":"<id>"}' --json
```

Administration — creating buckets, minting and revoking tokens, pinning and collecting — is the board or these verbs, never the CLI, and needs the root token, which the service reads from `$ODU_ROOT_TOKEN` and each verb takes as a field of its input:

```sh
export ODU_ROOT_TOKEN=...
odu surface cache bucket_create --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","name":"main","public":true,"retentionDays":30}' --json
```

**On a server with a door, the rule is your role.** Once [server mode](../docs/#server-mode) is configured, the root token is not an administrator — it exists to grant the first owner — and administration needs an `admin` or an `owner`:

```sh
odu surface auth user_whoami --json   # who this machine's token belongs to, and its role
odu surface cache bucket_create --input '{"rootToken":"","name":"main","public":true,"retentionDays":30}' --json   # as an admin, through the token odu auth login stored
```

A `member` sees every bucket and may read a bucket's URL, key and paths, but `bucket_create`, `token_mint` and `gc_run` are refused with `not_permitted` — and the board draws them none of those controls. On a daemon with no door the Cache view asks for the root token once per visit (kept in the page, never stored), because that is what this daemon's administration checks. Pushing does not change: a write token from `cache token_mint` is what a pusher carries, whoever minted it.

## Push

Save a write token for an origin once:

```sh
odu cache login http://127.0.0.1:18440
```

It reads the token from stdin (or `--token <token>`), and writes one entry per origin to `~/.config/odu/cache/credentials` (mode 0600). `odu cache push` resolves the token in this order:

1. `--token-file <path>`
2. `$ODU_CACHE_TOKEN`
3. the credentials entry for the bucket's origin

The bucket argument is a name resolved against the logged-in origin, or a full `https://<host>/cache/<bucket>` URL — the substituter URL `odu cache use` prints. CI exports the secret and never logs in — this is the block a bucket's page shows under **Set up → push**, with the token filled in the moment you mint one there:

```sh
# push — a write token, where the build runs
export ODU_CACHE_TOKEN=<your-write-token>
odu cache push --cache https://odu.example.com/cache/main <paths>
```

**One fact, not three.** `--cache <substituter>` takes the URL that is already in your `nix.conf` and reads the rest off that cache's own `nix-cache-info` — the push origin and the bucket — so a CI job holds nothing that goes stale when a bucket gains a domain or moves stores.

**Or name the bucket and its origin,** which is the form for a person in a shell who has both in hand:

```sh
export ODU_CACHE_TOKEN=<your-write-token>
odu cache push main <paths> --origin https://odu.example.com
```

The two are exclusive: they answer the same question from opposite ends. A cache that does not state both lines, or does not answer, is refused with a sentence naming the URL — a push aimed at a guessed origin is a push at a URL nobody owns. `--output json` is unchanged: it still answers `served` and `substituter`.

What it says while it works — one preamble, then one line per path as the bucket answers:

```text
118 paths in the closure: 6 to push, 108 already here, 4 upstream
✅ /nix/store/…-odu-0.1.0/bin/odu stored
⏳ /nix/store/…-big-output part 3
❌ /nix/store/…-bad-output refused: the upload was truncated or corrupted
```

A push records each path as it lands. There is no hold to wait for: references are names in the narinfo, not paths the server must already hold. The exit is non-zero only for refusals. The server keeps and serves the upload as it arrived — `nix copy --to` defaults to xz, `?compression=zstd` sends zstd — and `--wait` is deprecated: it returns at once, and `/held` answers an empty list until the cache row's next major.

Before it sends a NAR's bytes, a push asks the bucket **where they go**, and the answer comes from the bucket's store. On an **S3 store** the answer is `direct`: odu signs URLs, the client PUTs the NAR to the store itself, and **not one NAR byte crosses odu** — which then streams the object back, verifies its `NarHash`, size and `CA:`, copies it into place inside the store and only then records the path. Odu never signs a hash a client claimed. On a **disk store** the answer is `staged` and the NAR comes through the daemon as it always has. The bucket row says which as `writesTo` (`"store"` or `"odu"`), the push's `--output json` says which as `mode`, and there is no flag to set.

A NAR larger than `--part-size` (64 MiB by default) is sent in parts, each retried on its own; the server reassembles them and the same hash proof decides. That is what makes a push work through a proxy with a request-size ceiling — Cloudflare's is 100 MB. In **direct** mode nothing proxies the bytes, so `--part-size` is a FLOOR instead: a part is the largest of it, the store's own part size and S3's 5 MiB minimum. Every byte goes as a **part** of one multipart upload, a one-part NAR included — part 0's URL rides on the plan, so that common case costs no extra round trip, and completing the upload ends every URL odu signed for the key, which is what makes the object odu then reads back one nobody can rewrite. A presigned URL lives ten minutes; a part that misses it begins that path again with a new upload rather than refreshing a URL.

`push` asks the bucket which paths it is missing, then uploads only those, with retries. It talks to the cache's HTTP API directly, so it runs on the machine that holds the paths.

`--pin NAME` re-points that named pin at the closure the push just landed, so garbage collection keeps it — one command and one token, and nothing is pinned if any path was refused. `--output json` reports it as `pinned: {name, rootPaths}`, or `null` when no pin was asked for. The write token is the authority: a token that may push may already keep a closure alive forever by pushing it again, so pinning grants it nothing it lacked.

`--run ID` and `--commit SHA` state **what built** these paths. Both are opaque strings: the cache keeps them on every row this push stores and resolves neither, and the bucket page draws the commit short and the run as a link to its own page. A push that states neither leaves whatever a run already stated alone, so a developer's bare re-push of a path CI stored does not erase where it came from — and the two are independent, which is why the GitHub action states only `--commit`. A run started by `odu ci run` states both without being asked.

In GitHub Actions there is an action for it, and it pushes with the checkout's own `odu`: see [Push from GitHub Actions](#push-from-github-actions).

Prefer plain Nix? `nix copy --to` works without any odu code on the client:

```sh
nix copy --to http://127.0.0.1:18440/cache/main ./result
```

Nix reads credentials only from the file named by its `netrc-file` setting (default `/etc/nix/netrc`), never `~/.netrc` on its own. `odu cache use main` prints a `netrc-file` line pointing at your own file and the credential line to put in it:

```sh
netrc-file = /home/<you>/.netrc
machine 127.0.0.1 password <your-write-token>
```

`use` prints the placeholder rather than the token it could read: the block is pasted into a `nix.conf` and a `flake.nix`, which are read by people and committed.

For CI, put the token in the URL instead of provisioning a file:

```sh
nix copy --to "http://x:$ODU_CACHE_TOKEN@127.0.0.1:18440/cache/main" ./result
```

The server accepts any username and the token as the password.

### Compared with `cachix push` and `attic push`

| | cachix push | attic push | `odu cache push` |
| --- | --- | --- | --- |
| Closure, batched missing query, retries | yes | yes | yes |
| Skips paths cache.nixos.org already has | yes | yes | yes: the server drops paths signed by an upstream key, `cache.nixos.org-1` by default — or nothing, with `--no-upstream` (which also stores upstream closures, costing disk, for consumers that cannot reach cache.nixos.org) |
| Streams NARs, parallel uploads | yes | yes | yes: `nix store dump-path` through zstd, several paths at a time, retry per path |
| Uploads bypass the server | yes, straight to S3 | no | yes on an S3 store: presigned URLs odu mints, and odu reads the object back and verifies it before it signs anything. A disk store takes them through the daemon |
| Dedup | per NAR | per chunk | per NarHash per bucket |
| Pushes every build as it happens | `watch-exec`, `watch-store` | `watch-store` | not yet; a later release adds a post-build hook for lane hosts |
| Client signs with its own key | optional | no | no; the server signs |
| Client to install | cachix | attic | odu itself, or nothing: use `nix copy` with netrc |

Until the hook ships, a CI job pushes only the closures it names. Plain `nix copy --to` compresses each NAR in memory on the CLIENT before uploading and checks the cache one path at a time; the server keeps and serves the bytes exactly as they arrived (`nix copy --to` defaults to xz, `?compression=zstd` asks for zstd). That client-memory limit is why `odu cache push` exists; prefer it for large closures.

## Push from GitHub Actions

One step, in any repository. The action odu ships pushes with **its own `odu`** — built from the revision you pin the action to, so the pin is the pusher. A bucket page fills the revision in with the commit *its* server was built from, so the pusher matches the cache; a build that cannot say which commit it is from leaves the placeholder.

Then it proves the push. For every path the bucket serves, `check.sh` asks `<substituter>/<hash>.narinfo` — the address a Nix client asks, which is the store's public URL or the bucket's own domain when it has one — reads the narinfo's `URL:` and `FileSize:`, and requires the NAR to answer `200` with a matching `Content-Length`, following a redirect to the store as a client would. Plain HTTP throughout, so no local narinfo cache can answer for the bucket, and an object truncated by a proxy's body cap is caught rather than counted as landed.

```yaml
# .github/workflows — Nix installed in an earlier step
- uses: juspay/odu/.github/actions/push@<odu-revision>
  with:
    cache: https://odu.example.com/cache/main
    token: ${{ secrets.ODU_CACHE_TOKEN }}
    pin: ${{ github.ref_name == github.event.repository.default_branch }}
```

**`cache:` is the one fact — the substituter URL**, the same line your `nix.conf` already has. The push origin and the bucket name are read off `<cache>/nix-cache-info`, which states them ([The cache describes itself](#the-cache-describes-itself)). They cannot be derived any more: a bucket whose reads are served from a store answers `GET` at an address that takes no push at all. A cache that states neither refuses the step, naming the URL it asked.

**And `cache:` may be left out entirely**, when your `flake.nix` already names the bucket in `nixConfig` — which a repository that READS from it does. The step then asks `odu cache target` for that one substituter and pushes to it by name, token and all; no odu cache there, or two, fails the step naming what it found. Name `cache:` when the workflow builds for a cache the flake does not list, or when the bucket is **private** — the inference probes anonymously, and a private bucket answers its `nix-cache-info` to nobody. [Use odu from your repository](../docs/#use-odu-from-your-repository) is the consumer's whole of it.

**With no `paths`, the whole flake goes** — every `packages.<system>`, `devShells.<system>` and `checks.<system>` output for the runner's system, enumerated by Nix rather than listed by hand, so a flake that gains an output gains it here on the next push. Name `paths` to push exactly what you name instead: store paths, `result` links, or flake installables, space- or newline-separated, installables built first. A bucket page prints this block filled in with its own substituter URL under **Set up → GitHub Actions**.

**`pin:` is a boolean, and leaving it out is the policy.** The action holds none of its own beyond a default: left empty it pins whatever this push landed when `github.ref` is the repository's default branch, and an explicit `true` or `false` is obeyed exactly. The pin's NAME is derived — `<owner>/<repo>@<ref>/<system>`, e.g. `juspay/kolu@master/x86_64-linux` — because several repositories share one bucket and a matrix pushes a Linux closure and a macOS closure on the same commit; under one name the second job to finish would re-point the pin and hand the first job's closure to the next collection. Free-text pin names stay in the API, for the board and an administrator. An odu RUN takes a pin of exactly this shape from `[metadata("odu:pin")]` on a recipe — bare for the default branch, `odu:pin=<ref>` for another, repeated for more — so a repository that moves a workflow onto `odu ci run` keeps re-pointing the same pin rather than growing a second one.

**Nix must already be on the runner.** The action never installs it — the `extra_nix_config` block above is the `nix_conf` of whichever install step you already run.

**Your build is yours.** The installables named in `paths` are built with `--accept-flake-config` and nothing else: your flake's `nixConfig` and the runner's own configuration. The action adds no substituter and no key to a build it does not own. Where *odu itself* comes from is decided by odu's flake, which the pusher build accepts and does not overrule.

The token rides in an input fed from a secret, is never echoed, and is never consulted in an `if`. Leave it empty and the action's answer depends on the event:

| event | no token |
| --- | --- |
| `pull_request` | builds the paths, pushes nothing, says so, succeeds |
| `push` | fails, naming the missing secret — a push is where the job must publish |

The step summary is a table read from the push's own JSON (pushed, already present, skipped upstream, failed), not from its human output.

### From `attic push`

Chutney's workflow, before — a binary to install, a login that reads a JWT, a push:

```yaml
      - name: attic login
        run: attic login chutney https://cache.nixos.asia ${{ secrets.ATTIC_LOGIN_TOKEN }}
      - name: om ci
        run: om ci run --systems "${{ matrix.system }}"
      - name: attic push
        run: attic push chutney:oss result
```

After — the same three steps, with the first and last replaced by one that carries no credential of its own:

```yaml
      - name: om ci
        run: om ci run --systems "${{ matrix.system }}"
      - uses: juspay/odu/.github/actions/push@<odu-revision>
        with:
          cache: https://cache.kolu.dev/chutney
          token: ${{ secrets.ODU_CACHE_TOKEN }}
          paths: result
```

What changes in behaviour, not just in spelling:

| | `attic push` | the odu action |
| --- | --- | --- |
| Client to install | the `attic` binary | none: the action builds the pusher from its own pin |
| Credential | `attic login`, which writes a token to a profile | an input, from a secret |
| Upstream-signed paths | filtered client-side by config | dropped by the bucket in its `missing` query |
| Did it land? | trust it, or `nix path-info` against the cache | every served path's narinfo is asked over HTTP; a miss is red and named |
| What a maintainer reads after a run | attic's log | a table in the step summary, from the push's JSON |

Chutney's `attic` cache is `chutney:oss` — a cache and a sub-cache. An odu bucket is one cache, so the migration is a bucket named for the project (`chutney`), and its upstream filter is what `oss` was for.

## Private buckets

A public bucket reads without a token. Reads from a private bucket need the same credential as a write: netrc for `nix copy` and substitution, or `Authorization: Bearer <token>` for HTTP clients. Writes always need a token.

An unauthenticated read of a private bucket answers **404**, not 401: "you need a token" would confirm the bucket exists, and a private name must not be enumerable. A caller who presents a token that is wrong, revoked, expired or scoped elsewhere gets 403.

## Keep and reclaim

```sh
odu surface cache pin_create --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","bucket":"main","name":"release-1.2","paths":["./result"]}' --json
odu surface cache gc_run --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","bucket":"main"}' --json
odu surface cache stats_read --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'"}' --json
```

**Retention counts from the last time somebody wanted a path**, not from the last time one was read. A path's `lastWanted` is renewed by a stored push, and by the `missing` query a push asks first — whether the bucket was missing that path or already had it. A read never renews it; a read moves `hits` and nothing else. That is deliberate: reads are leaving odu, and a clock a read wound would make the busiest paths in the cache the first to look idle.

A bucket keeps what nobody wants for **90 days** unless it says otherwise. `cache bucket_create` takes the number at creation, the bucket page's **Retention** control (`cache bucket_retention`) changes it afterwards, and zero means "keep only what something references or a pin holds".

**A pin is a name over a closure.** Pinning under a name that already exists re-points it: the same name, today's closure, yesterday's roots let go in the same statement. Garbage collection walks the bucket's own references out from a pin's roots, so a path pushed later under a pinned root is held too.

**Read the dry run before you collect.** It answers exactly what the next collection would take — the count, the bytes it would free, and the oldest-wanted paths, first to go at the top — and does nothing at all. On the board it is the **Dry run** button beside **Run GC**; to an agent it is `cache_gc_plan`.

**The dry run has a retention of its own.** `cache_gc_plan` takes an optional `retentionDays` — a whole number of days, zero or more — and plans as if every bucket in scope kept a path that many days from `lastWanted`; absent is each bucket's own number, and `0` answers the question underneath retention entirely: what is here that nothing references and no pin holds. Anything else is refused `bad_input` with "retention must be a whole number of days, zero or more". Nothing is written — the override is a row the plan makes up for the length of the answer, and only **Retention** (`cache bucket_retention`) changes what a bucket keeps. It is the plan's field and the plan's alone: `cache_gc_run` has no such input, so a dry run at a retention nobody agreed to cannot become a collection by another name. On the board it is the **dry run retention days** field beside the button, placeholder "its own", and a plan taken with one says so underneath — "At N days' retention — the bucket keeps its own — …".

**Collection also happens on its own, once a day,** over every bucket, so a cache nobody administers still stops growing; `cache gc_run` and **Run GC** are that same collection asked for sooner. An object is evicted only when retention has expired, nothing retained in the bucket references it, and no pin holds it. A collection of *every* bucket also sweeps **orphans** — object keys the store held that no row ever named, a put whose record never landed — and reports them beside what it evicted. It collects with nothing but the store's own `list` and `deleteMany`, so a bucket on R2 collects exactly as one on local disk. Whatever was deleted is announced as URLs: a bucket behind a Cloudflare tunnel has them purged at the edge, and with no CDN in front nothing is purged because nothing was cached.

**A collection runs in batches, and one that stops says why.** Each batch deletes its objects — five hundred rows at a time, one request per thousand keys where the store has such a call — and only then forgets the rows, so nothing is ever forgotten before its bytes are gone. A store that refuses a delete (R2 answers `429` when it is being asked too fast; odu asks again five times, backing off) ends the run with `stopped`: one plain sentence, drawn as the red line in the GC box, never a service's XML. What was evicted is on the report beside it, everything unconfirmed is still recorded, and pressing **Run GC** again carries on from there. The write lock is held for the plan and for each batch's decision, never across a delete, so a push lands while a collection is running instead of queueing behind it.

On the board, a bucket page is two columns. The main one opens on a **Paths | Pins** tablist — the paths it serves as a sortable table grouped by name, each row naming the commit it was built from and linking the run that pushed it where the push said so, or the pins holding closures against collection as a table of their own (name, system, paths, when, who made it; pressing a pin's name opens its roots under the row, ten of them until you ask for the rest). Under them is **Set up**: the substituter URL, the public key, and one block over a tablist — `nix.conf`, `NixOS`, `flake.nix`, `odu CLI`, `push`, `GitHub Actions`. Both lists are read when the page opens, so each carries a **refresh paths** / **refresh pins** beside it; the facts line under the bucket's name needs none, because the row republishes whenever a push, a pin or a collection moves it. The side column is what the bucket IS: **Root token** (on a daemon with no door), **Tokens**, **Retention**, **Domain**, **Move to another store** (drawn only when this daemon declares a store to move to), **Garbage collection**, and a **Danger zone** with **Delete this bucket** in it.

### Delete a bucket

```sh
odu surface cache bucket_delete --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","bucket":"r2test"}' --json
```

On the board it is the last panel on a bucket page's admin side, **Delete this bucket**: type the bucket's name into the field beside the button and **Delete bucket** lights up. Nothing else confirms it, and when it is done the board is back on the bucket list.

**The objects go first, then the rows.** Every NAR, every narinfo beside one, the bucket's own `nix-cache-info`, and anything else left under its prefix — an orphan no row ever named, a temp a dead put left — is deleted from the bucket's store, and what the verb answers is that count and those bytes: `objects` and `bytes` are store objects removed, not paths. Only then do the rows go: the bucket, its paths, its pins and the tokens whose bucket glob is exactly this name. A wider glob — `team-*` — is left alone, because it was never this bucket's token. There is no pin guard: a pin is a name over a closure in a bucket that will not exist.

**A bucket with a domain is refused until you clear the domain.** `bucket_domain` with no `domain` takes the name away; deleting the bucket under it would leave a DNS record pointing at nothing. A bucket with a [move](#move-a-bucket-to-another-store) in flight is refused too — let the copy finish, or the delete would race it. Both refusals say so in a sentence, and the board shows that sentence in place.

Whatever was deleted is announced for purging at the edge, as a collection's evictions are. To an agent the verb is `cache_bucket_delete`; there is no `odu cache delete` — a cache is administered from the board and from `odu surface cache`.

## Keep a bucket on S3

A bucket keeps its objects in a **store**: `local`, the server's own disk (always there), or an S3-compatible bucket you declare — Cloudflare R2, AWS S3, Garage, versitygw, MinIO. The store is chosen when the bucket is created, and a bucket moves between stores with [`bucket_migrate`](#move-a-bucket-to-another-store). Every store holds the whole protocol — the NAR, the narinfo beside it, and the bucket's `nix-cache-info` — so a store can answer a reader on its own; what differs is who hands a NAR over, odu or the store ([Reads leave odu](#reads-leave-odu)).

| | `local` | an S3 store |
| --- | --- | --- |
| Declared | never — always there | `services.odu.cache.stores.<name>`, or `$ODU_OBJECT_STORES` |
| Objects at | `<state>/cache/objects/<bucket>/nar/` | `<s3-bucket>/<bucket>/nar/` |
| A put that finds the key | refused, first kept wins (`link`) | refused, first kept wins (`If-None-Match: *`) |
| `FileHash`/`FileSize` kept | beside the object (`objects/.facts/`) | as object metadata (`x-amz-meta-odu-*`) |
| A large upload | streamed to a temp file | multipart, 8 MiB parts, four at a time, bounded memory |
| A read odu does itself (verifying, copying, collecting) | the file, from any offset | ranged GETs, 1 MiB at a time with the next one prefetched; no HEAD first |
| A name the world may read it at | never | `publicUrl`, an R2 custom domain bound to the bucket |
| A NAR a client pushes | odu takes the bytes into staging | the CLIENT PUTs it to presigned URLs; odu reads it back, verifies it and copies it into place |

A put is put-if-absent within one daemon on every store. Between two daemons writing one S3 bucket's prefix it holds where the service honours `If-None-Match` on the write that finishes the object: AWS does on both [`PutObject` and `CompleteMultipartUpload`](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html); R2 [documents it on `PutObject`](https://developers.cloudflare.com/r2/api/s3/api/) and, measured against R2 in November 2026, honours it on `CompleteMultipartUpload` too (412) while ignoring it on the one-request `CopyObject` — which is why odu's server-side copy is a multipart copy and is conditional at its completion.

### Set up an R2 bucket

Either way, you end with four facts: the **Account ID**, a private **bucket**, and an **Access Key ID** and **Secret Access Key** that may read and write only that bucket.

**From the Cloudflare dashboard**

1. **R2 object storage → Create bucket**, say `odu-cache`. Leave public access off unless you mean to serve this store's public buckets from a domain of its own ([A public URL for a store](#a-public-url-for-a-store)); with it off, every read goes through odu, which checks the bucket's tokens.
2. **R2 object storage → Account Details → API Tokens → Manage → Create Account API token**. Permissions: **Object Read & Write**; under the bucket scope, pick only `odu-cache`.
3. Copy the **Access Key ID** and the **Secret Access Key**; the secret is shown once. The page also shows the endpoint, `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.

**From the [`cf` CLI](https://developers.cloudflare.com/cf/)** (`npx -y cf@latest`, written `cf` below)

```sh
cf auth login                                   # approve in the browser
export CLOUDFLARE_ACCOUNT_ID=<ACCOUNT_ID>       # the account cf acts on
cf r2 buckets create --name odu-cache
# the ids of the two bucket-scoped permission groups (the name is URL-encoded):
cf user tokens permission-groups list --name 'Workers%20R2%20Storage%20Bucket%20Item%20Write'
cf user tokens permission-groups list --name 'Workers%20R2%20Storage%20Bucket%20Item%20Read'
cf user tokens create --name odu-cache --policies @policy.json
```

A **user** token, because that is what an OAuth login may create: `cf accounts tokens create` is refused under `cf auth login` (`9109 Unauthorized`, 403). A user token stops working if that user leaves the account; an account token from the dashboard does not.

with `policy.json` naming the one bucket (`default` is the jurisdiction of a bucket created without one):

```json
[{
  "effect": "allow",
  "resources": { "com.cloudflare.edge.r2.bucket.<ACCOUNT_ID>_default_odu-cache": "*" },
  "permission_groups": [{ "id": "<Item Write group id>" }, { "id": "<Item Read group id>" }]
}]
```

The new token's answer carries its `id` and its `value` (shown once). R2's S3 credentials are derived from them, [as Cloudflare documents](https://developers.cloudflare.com/r2/api/tokens/): the **Access Key ID** is the token's `id`, and the **Secret Access Key** is the SHA-256 of its `value`, in hex:

```sh
printf %s '<token value>' | sha256sum | cut -d' ' -f1
```

Measured on R2 with keys derived this way: a list answers 200, a put 200, a second put of the same key with `If-None-Match: *` **412**, and a delete 204 — the put-if-absent odu relies on.

**Then, either way**, write the credentials file on the server, readable by root only (an agenix or sops secret is the usual home):

```sh
# /run/secrets/odu-r2
AWS_ACCESS_KEY_ID=<Access Key ID>
AWS_SECRET_ACCESS_KEY=<Secret Access Key>
```

On NixOS, declare the store and create the bucket on it:

```nix
services.odu.cache.stores.r2 = {
  endpoint = "https://<ACCOUNT_ID>.r2.cloudflarestorage.com";
  bucket = "odu-cache";
  region = "auto";
  credentialsFile = "/run/secrets/odu-r2"; # AWS_ACCESS_KEY_ID=… / AWS_SECRET_ACCESS_KEY=…
};
```

```sh
odu surface cache bucket_create --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","name":"main","public":true,"retentionDays":30,"store":"r2"}' --json
```

On the board, the **Create bucket** form offers the declared stores, and a bucket's page says where its objects are (`objects on r2`). The credentials file is a systemd credential: never in the Nix store, never in the database, never logged; the key needs object read, write, delete and list. Without the module, point `$ODU_OBJECT_STORES` at a JSON file of the same shape — `{"r2": {"kind": "s3", "endpoint": …, "bucket": …, "region": …, "credentialsFile": …, "publicUrl": …}}` — before `odu web` starts.

- **One S3 bucket, many odu buckets.** Each odu bucket is a key prefix of its own name; odu lists, sweeps and deletes nothing outside those prefixes, so the S3 bucket may hold other things.
- **`endpoint` must be reachable from the CLIENTS.** Since reads left odu, a NAR on an S3 store is a redirect to a presigned URL built from this endpoint and followed by `nix build` — so loopback, a VPC-only name or a tailnet name only the daemon resolves will break every NAR read. See [A NAR is a redirect](#a-nar-is-a-redirect).
- **A store a bucket still names cannot be removed.** The cache row refuses to mount, naming the bucket and the store, rather than serve 404 for every path it has.
- **Moving a bucket between stores** is `bucket_migrate`, below. Uploads still go through odu; sending them straight to the store is a later release.
- **Abandoned multipart uploads** are aborted by the push that started them. One whose daemon was killed mid-upload (eviction, OOM, `kill -9`) is aborted by the next boot, which lists the bucket's incomplete uploads and aborts those begun before it; a lifecycle rule (R2 and AWS: "abort incomplete multipart uploads") is a second net, not the first.

## Reads leave odu

Every byte used to cross the odu machine's uplink. It no longer has to: the store holds the whole protocol, so a reader can be sent to the store — for a public bucket, permanently, and for everything else for the ten minutes a signature lasts.

What a push writes as objects, beside the row it records in SQLite:

| Object | Written by | `Cache-Control` |
| --- | --- | --- |
| `<bucket>/nar/<narHash>.<ext>` | the push, as the bytes arrived | `public, max-age=31536000, immutable` |
| `<bucket>/<hash>.narinfo` | the push, signed with the bucket's key | `public, max-age=86400` |
| `<bucket>/nix-cache-info` | `bucket_create` | `public, max-age=86400` |

A cache that predates this has rows but no narinfo objects. At boot, after the row is already serving, odu walks every bucket and writes the missing ones, two at a time, logging `cache.narinfo.backfill {bucket, written, remaining}`. It is idempotent — an object already there with the rendered text's length is skipped on one HEAD — so a daemon restarted half way through costs a walk, not a rewrite. Garbage collection deletes a row's narinfo object with the row: a narinfo nobody can get a NAR for is worse than no narinfo.

### A public URL for a store

A store may say where the WORLD reads it:

```nix
services.odu.cache.stores.r2 = {
  endpoint = "https://<ACCOUNT_ID>.r2.cloudflarestorage.com";
  bucket = "odu-cache";
  region = "auto";
  publicUrl = "https://cache.example.com";   # the custom domain bound to odu-cache
  credentialsFile = "/run/secrets/odu-r2";
};
```

An origin and nothing more — no path, no query, no fragment — because odu appends `/<bucket>/<key>` to it; anything else refuses the rebuild. One S3 bucket still serves many odu buckets, each under its own name: `https://cache.example.com/main/nix-cache-info`.

**A public bucket on such a store is advertised there.** Its substituter URL — on its page, in `bucket_describe`, in `odu cache use` — becomes `<publicUrl>/<bucket>`, and the bucket page says **reads served from cache.example.com** rather than **reads served by odu**. Nothing about reading it touches the daemon, so the cache keeps serving while odu is down, redeployed, or at zero replicas. Odu still signs its own requests against `endpoint`: the public name is for readers, never for writes, and `odu cache push` keeps addressing `/cache/<bucket>` on the server.

**A private bucket may not live on such a store, and odu refuses it.** The domain you bound serves the whole S3 bucket, every prefix in it, so a private bucket on it would be fetchable by anyone who can guess `<publicUrl>/<bucket>/<hash>.narinfo` — whatever odu's own routes decide. `cache_bucket_create` and `cache_bucket_migrate` refuse `public: false` onto a store with a `publicUrl`; a private bucket that was already there when you bound the domain is named at every startup with `cache.bucket.exposed`, and the fix is to move it to a store with no public name. A store-fronted PUBLIC bucket may still carry a [domain of its own](#a-domain-for-a-bucket) — odu honours it for writes and for the `missing` query — but the address advertised to readers is the store's, because that is the one that answers when odu does not.

**You bind the domain; odu does not.** For R2, one command:

```sh
cf r2 buckets domains custom create <r2-bucket> --domain <host> --zone-id <zone>
```

The cloudflare row has no R2 API: it binds tunnels, creates DNS records and purges the edge, and it is untouched by this. Odu checks your work instead — at boot, for each store with a `publicUrl` and at least one public bucket on it, it fetches `<publicUrl>/<bucket>/nix-cache-info`; anything but a 200 with the expected body is one `cache.store.public.unreachable {store, url, status}` line and never a refused boot, because a domain that is still propagating must not take the cache down.

### A NAR is a redirect

`GET /cache/<bucket>/nar/<file>` on an **S3 store** answers **307** with a presigned URL that expires in ten minutes, and no body. A `307` rather than a `302` because the method must survive the hop: a HEAD that came back as a GET would hand a client asking "is it there?" a whole NAR.

- **It works for a private bucket** because odu authorises first and only then hands out a URL that carries its own authority. Make the store's host differ from odu's and curl drops the `Authorization` header on the redirect, which is exactly what you want: the token never reaches the store.
- **`Range` is the client's and the store's.** Odu proxies none of it; a client re-sends its range to the presigned URL and the store answers the 206, so a resumed download never touches the daemon.
- **The redirect itself is `private, no-store`** on every bucket, public or not: it holds a signature that expires, and an edge that cached it would hand out a dead URL long after.
- **A disk store still streams from odu**, with `Content-Length` and `Range`, exactly as before.
- **The store's `endpoint` is now a CLIENT's address.** The presigned URL is built from it, so it has to resolve and be reachable from wherever `nix build` runs. A loopback endpoint, a VPC-only name or a tailnet name only the daemon can see turns every NAR read into a failure on the client's side with nothing in odu's log — odu says `cache.store.endpoint.unreachable {store, endpoint, host}` at startup for the cases it can be sure of (loopback and link-local).
- **What odu gives up** is the byte count: `cache.nar.served` gains `source: "redirect"` with `bytes: 0`, because there is no body to observe.

Narinfos and `nix-cache-info` asked of odu are still rendered from SQLite and answered by odu. An anonymous read of a private bucket is still 404.

### Move a bucket to another store

```sh
odu surface cache bucket_migrate --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","bucket":"main","store":"r2"}' --json
```

On the board it is a bucket page's **Move to another store** panel: pick a store under **Where to move it**, then **Start move**. A daemon that declares only one store says so instead.

**The bucket keeps serving from the OLD store the whole time.** Every object — the NARs, the narinfo beside each one, `nix-cache-info` — is copied first, two at a time; only when the copy is complete does the bucket change hands, under the same lock a push takes, with a last delta pass inside it so a path that landed mid-move is not left behind. Then the old copies are deleted and their URLs purged at the edge. A move that flipped first would be a substituter that 404s everything until the copy caught up.

The verb answers the bucket's **row** as soon as the move is recorded — the copying runs in the background — and progress is the `migration` field on that row, which the board follows live and an agent reads from `bucket_list`:

| Field | What it says |
| --- | --- |
| `to` | the store it is moving to; the `store` beside it is still where reads come from |
| `state` | `copying` fills the new store, `flipping` is the moment the bucket changes hands, `deleting` lets the old copies go |
| `copied` / `total` | objects dealt with, out of what the move found |
| `bytes` | bytes copied so far |

It is `null` when nothing is moving. The panel says it in a sentence — "Copying to r2: 12 of 40 objects, 3.0 MiB."

It is resumable: an object already in the new store with the same length is skipped, and the move's own row survives a restart, so a daemon that died half way through carries on rather than starting again. It refuses a store this daemon does not declare, the store the bucket is already on, a second move of the same bucket, and anyone who is not an administrator.

## Where the data lives

The cache keeps **the compressed NAR the pusher sent**, once, and no Nix store of its own. That is the Cachix/Attic model: an object is a content-named file (`<bucket>/nar/<narHash>.<ext>`, where the extension is the stored compression), references are names in the narinfo, and nothing is imported. On the pod this replaced a 166 GB `/nix/store` of upstream closures nobody pulled from us.

- A push assembles (or receives) `nar/<narHash>.<ext>`, decompresses and hashes it against the narinfo's `NarHash`, then **keeps the file** and records its sha256 and length as `FileHash:`/`FileSize:`. One write, no second copy; the same NarHash+compression keeps the existing file, and twins share one object until GC deletes it with the last row.
- Serving is the object, from the bucket's store, with `Content-Length` and `Range` — or, on an S3 store, a 307 to the store itself ([Reads leave odu](#reads-leave-odu)). When odu does stream it: Cloudflare's 512 MB per-file CACHE limit means larger objects are served uncached through the tunnel, not refused — and its 100 MB request cap is why pushes are chunked. A 634 MB NAR pulls through a cold edge. The server never re-dumps or re-compresses a path per reader.
- A narinfo whose references are absent is recorded anyway: references are names, not paths a store must hold first. A `.drv` path, or a reference to one, is still refused with 400.
- `CA:` is **proved from the object we hold**: odu recomputes Nix's `fixed:r:sha256` store path from (name, references and bytes) and serves the line only when the formula reproduces the path. A non-self row uses its NarHash; a self-referencing row uses Nix's hash-modulo-self-references, computed while the NAR streams through verification. Old rows get a one-time background pass after the cache is serving (two workers, progress logged), and the verdict is persisted so a row is read once. Nothing is taken from the pusher.
- A push also writes the narinfo beside the NAR (`<bucket>/<hash>.narinfo`) and `nix-cache-info` is written at bucket create, so the store holds a readable cache on its own. GC deletes a row's narinfo object and then its NAR, and only then drops the row; an object with no row (a crash between put and record, or a collection that stopped between the two deletes) is swept at boot and logged, and the sweep knows all three kinds of key, so it cannot mistake a narinfo for an orphan.
- **The one-time migration.** A deployment upgrading from the store-backed cache has rows whose object is not on disk. After the cache is mounted and serving, two at a time, odu dumps each from the old store (`$ODU_CACHE_STORE`, or the host's own `/nix/store` when unset) into the object store. It pauses below 10 GiB free and re-checks every minute, resuming without a restart. Until a row's object lands, its NAR is served through the old store (logged as `source: transition`); a row the old store does not have answers 404 and is named once. A row whose object is missing or unreadable is retried by the next boot's background work, not by a request. The log line `cache.migration.complete` says every row has its object and the old store can be deleted. On the module shape the old store is the host's `/nix/store`: delete the abandoned roots under `<state>/cache/gcroots`, then let `nix-collect-garbage` reclaim the paths; do not delete `/nix/store`.
- **Sizing.** Disk is the compressed objects plus staging for the largest in-flight NAR; memory is constant per NAR, not proportional to its size. A `--no-upstream` bucket also stores every upstream-signed closure it is pushed, so budget that disk deliberately.

```text
<state>/cache/cache.sqlite            metadata, bucket signing keys, token hashes, pins
<state>/cache/objects/<bucket>/       nar/<narHash>.<ext> (immutable), <hash>.narinfo,
                                      nix-cache-info
<state>/cache/staging/                uploads between their NAR and their narinfo
```

An upload sits in `staging/` until its narinfo arrives; one that never gets it is swept after an hour, so a client killed between the two PUTs cannot leak a NAR. Back up the database **and** the objects — `objects/`, and each S3 store's bucket: the bytes are not rebuilt from anywhere else.

`<state>` is `$ODU_STATE_DIR` if set, else `$XDG_STATE_HOME/odu` (`~/.local/state/odu` by default) on Linux and `~/Library/Application Support/odu` on macOS, the same place as the run catalog. Tokens are stored only as hashes, so a copy of the database cannot be used to push. The signing keys are in it, so treat it as a secret.

**The daemon's own home is the one thing that is not under `<state>` by default.** It holds the singleton's gate and control socket, and its name is derived from the origin — `odu-web` at the default origin, `odu-web-<hash>` at any other, so two services cannot share one. Without `$ODU_STATE_DIR` it is `$HOME/.local/state/odu-web*`: a SIBLING of `odu` rather than a child of it, and deliberately not under `$XDG_STATE_HOME` — that variable varies by launch context (a login shell, a bare ssh, a systemd unit), and two contexts computing two "state" homes would split one daemon's identity. Set `$ODU_STATE_DIR` and the home moves inside it, which is what a container with a read-only `$HOME` wants.

The service needs no `nix.settings.trusted-users` entry and no Nix store: it never imports a path. Running all of this on a NixOS host, with the state under `/var/lib/odu` and nginx in front, is [Self-host on NixOS](../docs/#self-host-on-nixos).

## A domain for a bucket

A bucket is served at `https://<your odu>/cache/<bucket>`. Give it a name of its own — `https://cache.kolu.dev` — and that is the URL people put in `nix.conf`, and it stays the same when the server moves.

Odu does the wiring itself through Cloudflare. Hand it one API token and set the domain on the bucket; there is nothing else to run.

### Create the Cloudflare token

In Cloudflare, **My Profile → API Tokens → Create Token → Custom token**:

| Field | Value |
| --- | --- |
| Token name | `odu` |
| Permissions | **Zone → DNS → Edit**, **Zone → Zone → Read**, **Account → Cloudflare Tunnel → Edit** |
| Zone Resources | Include → Specific zone → `kolu.dev` (one line per zone you will use) |
| Account Resources | Include → your account |

### Give it to odu

| | |
| --- | --- |
| `ODU_CLOUDFLARE_API_TOKEN_FILE` | a file holding the token — a systemd credential under the module |

With the NixOS module, `services.odu.cloudflare.apiTokenFile`. The token is verified at boot: a missing or inactive one refuses the row with Cloudflare's own sentence, rather than a panel that never moves.

### Set the domain

On the bucket's page, under **Domain**, type `cache.kolu.dev` and save. Or, for parity:

```sh
odu surface cache bucket_domain --origin https://odu.example.com \
  --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","bucket":"kolu","domain":"cache.kolu.dev"}' --json
```

Odu then:

1. creates one Cloudflare Tunnel for this server, named after its public origin, the first time any name is set;
2. routes every name through that tunnel to the cache;
3. creates each proxied DNS record;
4. starts the `cloudflared` connector as a child of the daemon (as it does `nix` only during a migration).

A name is **wiring** while that happens, **live** once `https://<name>/nix-cache-info` answers, or **failed** with Cloudflare's reason (a token without the DNS permission; a zone the token cannot see). The bucket page's route strip and the board's **Tunnel** page show it, and `odu surface cloudflare status_read --json` asks from a terminal. The tunnel page also shows the connector: running, connected, stopped, or failed with the last words `cloudflared` said.

Once live, the bucket's **Set up** block and `odu cache use kolu` print the new URL; the old `/cache/kolu` URL keeps working. Pushes are unchanged: `odu cache push kolu` finds the bucket by name.

**A store's public URL wins over a bucket's domain**, for a public bucket on a store that declares one: the advertised read URL is `<publicUrl>/<bucket>` ([A public URL for a store](#a-public-url-for-a-store)), because that is the address that answers when odu does not. The bucket's own name keeps working for writes and for the `missing` query, which are odu's either way.

**The name serves only the bucket.** `/` is the bucket's public page, the Nix protocol's paths (`/nix-cache-info`, `/<hash>.narinfo`, `/nar/<file>`, the push API) are served, and everything else on that hostname — the board, `/mcp`, `/auth`, `/rpc/ws` — is the cache row's 404. The tunnel forwards every path, so the daemon's `Host` routing is what keeps the control plane off a substituter's name; the board stays on `cache.domain`.

**The server's own origin rides the same tunnel** when its host is in a zone the token can edit — the board, `/mcp` and the websocket. That is what lets a Tailscale Funnel retire; the GitHub App's callback URL then moves to that name.

### Remove it

Clear the **Domain** field, or send `bucket_domain` with no `domain` (`'{"rootToken":"…","bucket":"kolu"}'`). Odu removes the route and the DNS record. The tunnel itself is this server's and stays; the connector stops when the last name goes.

### What it does not do

A domain is a name, not a lock. Reads on a public bucket stay anonymous whether you reach it by `/cache/kolu` or by `cache.kolu.dev`. Private buckets — read with a token — come with teams.

The connector needs outbound HTTPS from the server and nothing inbound: no port is opened on your network, and your server's address never appears in DNS.

## The Cache view

`odu web`'s page has **Runs** and **Cache** in the header. `#/cache` lists the buckets — name, public or private, how many paths, how much space, when it last took a push, how many reads — and `#/cache/<bucket>` is one bucket: its substituter URL, its public key, the `nix.conf` / netrc block above ready to copy, and its paths as a table of **name · hash · size · pushed · reads · wanted**. The facts line says who answers a read of it — **reads served from cache.example.com**, or **reads served by odu**.

**The paths table is grouped by name by default**, because a bucket is mostly one package over and over: `odu-base-0.1.0` with six builds in it is one row carrying the count, their total size, the newest push and the summed reads — **counted by the row over the whole bucket**, not over the page on screen (`cache_bucket_paths` takes `group: "name"`, and opening a row reads that package's versions with `name`, and its own **show N more** pages within the group from the same cursor). Press **group by name** to turn it off for a row per path. Click **name**, **size**, **pushed** or **reads** in the header to order by it (again to reverse; the header says which way, and so does `aria-sort`) — the order and the paging are the row's too, so **Show 20 more** continues the same order rather than re-sorting what arrived. The filter box narrows what the bucket answers, and a hash is the first eight characters, with the whole store path in its `title` and on the clipboard when you click it.

**The view does everything the cache row serves**, except push, which is a build box's job — and since the admin CLI retired, the view and `odu surface cache <verb>` are the two ways to administer a bucket. Anyone may read: the page asks `cache_bucket_describe` and `cache_bucket_paths`, which take no credential, because a bucket's URL, its key and its path list are what the substituter already publishes. An admin is also drawn the administration: **Create bucket** (with **Skip upstream paths** — off is `upstreamKeys: []`) on the list, and on a bucket page a **Pins** tab beside **Paths** (pin a closure; what each pin holds, roots folded behind *what it holds* with a **show all** when there are more than the row draws; delete one) and a settings column — **Tokens** (mint write or read, shown once; list; revoke), **Retention**, **A name of its own**, **Move to another store**, **Garbage collection** (**Run GC**, and a **Dry run** with its own **retention** field beside it, which the button says back: *Dry run at 0 days*) and, behind a **Danger zone** rule, **Delete this bucket** — which asks you to type the bucket's name before its button will do anything, and goes solid red once you have, returning to the list when the bucket is gone. The dry run is asked for rather than taken on arrival, and is asked again after every collection — "what am I about to lose" is a question a report answers too late, and a question nobody asked must not answer in red. The retention field is the dry run's alone: blank is the bucket's own (the placeholder says which number that is), and nothing you type there changes what the bucket keeps or what **Run GC** would evict. The controls are drawn by role and refused by the row on its own, so a hidden button is never the only check.

The bucket rows arrive over the wire the page already holds, so a push from a build box moves a bucket's counters — on the list and in its facts line — without a reload; reads are folded into those counters at most once a second rather than once per NAR. The path list and the pin list are pages read when you open them, which is what **refresh paths** and **refresh pins** ask again.

## Operating it

Watch these lines on a foreground `odu web` (it prints a row's operational `info`, and drops host narration):

- `cache.migration.start` / `.progress` / `.pause` / `.resume` / `.complete` / `.incomplete` — objects, NAR bytes, free space. On `incomplete`, the rows it names have no object and no old-store copy: their NAR answers 404 until re-pushed.
- `cache.self_ca.start` / `.progress` / `.complete` — the one-time self-reference proof pass, with rows, bytes, proved/refused/unreadable.
- `cache.nar.served` — path, bytes actually written, ms, `source` (`object` from the bucket's store, `transition` from the old Nix store, `redirect` for a 307 to an S3 store, which always says `bytes: 0`), `cancelled`.
- `cache.nar.unavailable` — no object and the old store lacks it; served as 404 once per path.
- `cache.boot.orphans`, `cache.boot.ca` — sweep and metadata-CA counts at boot.
- `cache.import.recorded`, `cache.request.refused`, `cache.object.put_failed`.
- `cache.nar.verify_failed` — an upload odu would not vouch for, refused with `400` (`bucket`, `path`, `file`, `mode`, `reason`). The reasons: `absent` (the narinfo names a NAR nothing uploaded), `unreadable` (the bytes would not decompress or would not read), `nar_hash_mismatch` (they hash to something else), `unversioned_source` and `source_changed` (the readback's version could not be bound, or was gone by the copy), and `short_read` (a **direct** upload's readback was promised bytes that are no longer there: a window answered fewer bytes than its range, or a later window answered `412`/`416`). `short_read` is not a verdict on the NAR — the path can simply be pushed again.
- `cache.gc` — one line per collection, scheduled or asked for: `evicted`, `kept` (rows whose bytes a twin still names), `orphans`, `bytes`, and `stopped` when the store refused a delete. `cache.gc.purge` says, per bucket, how many URLs were announced; `cache.gc.failed` is a scheduled pass that hit something, with the next one still scheduled.
- `cache.narinfo.backfill` — the boot pass that writes missing narinfo objects: `bucket`, `written`, `remaining`, one line per five hundred rows and one at the end. `cache.narinfo.object_failed` names a text object that could not be written (`bucket`, `path`, `reason`).
- `cache.narinfo.purge` — a re-push rewrote a narinfo object, so the address it was cacheable at is announced to the edge (`bucket`, `urls`). The NAR is never in it: it is named by its own bytes and cannot change.
- `cache.store.public.unreachable` — a store's `publicUrl` did not answer `nix-cache-info` at boot (`store`, `url`, `status`). Odu goes on serving; readers pointed at that domain do not.
- `cache.store.endpoint.unreachable` — a store's `endpoint` is a loopback or link-local address and a bucket lives on it (`store`, `endpoint`, `host`). Clients follow a redirect to that address since reads left odu, so this is every NAR read failing on the client's side.
- `cache.bucket.exposed` — a PRIVATE bucket sits on a store with a bound `publicUrl` (`bucket`, `store`, `url`), so its objects are readable by anyone who knows the name. New ones are refused; this names the ones that predate the binding.
- `cache.bucket.migrate.start` / `.progress` / `.flipped` / `.done` / `.failed` — a store move, with `copied`, `total` and `bytes`. `cache.bucket.migrate.purge` is the old store's URLs it asked the edge to drop.
- `cache.bucket.deleted` — a bucket was taken away (`bucket`, `objects`, `bytes`: the store objects removed under its prefix and what they weighed). The one record of a bucket whose own rows are gone, so it is what an operator reads afterwards. `cache.bucket.delete.purge` is the addresses it served, announced to the edge (`bucket`, `urls`).

## Protocol

One bucket is one substituter. Point any Nix-compatible tool at these routes:

```text
GET  /cache/<bucket>/nix-cache-info             StoreDir, WantMassQuery: 1, Priority: 41
HEAD /cache/<bucket>/<hash>.narinfo
GET  /cache/<bucket>/<hash>.narinfo
GET  /cache/<bucket>/nar/<narHash>.<ext>       the object: streamed from a disk store with
                                               Content-Length + Range, or 307 to the S3 store
PUT  /cache/<bucket>/nar/<narHash>.<ext>         Bearer or Basic; any ext Nix sends
POST /cache/<bucket>/nar/<file>/upload          where do this NAR's bytes go?
GET  …/nar/<file>/upload/<id>/parts/<i>         a presigned PUT for one part
POST …/nar/<file>/upload/<id>/complete          join the parts, confirm the object
PUT  /cache/<bucket>/<hash>.narinfo             server re-signs with the bucket key
POST /_odu/v1/buckets/<bucket>/missing          batch "which of these are you missing"
POST /_odu/v1/buckets/<bucket>/pin              name a closure a WRITE token keeps
GET  /cache/<bucket>/                           a public bucket's facts: the use block,
                                                or JSON on Accept: application/json
```

**Priority 41 is one worse than `cache.nixos.org`'s 40, on purpose.** A bucket created to take everything also holds upstream-signed paths, and at an equal priority the client's own substituter order decides who serves them — this machine's uplink, or the CDN that would have served them from nearer and for free. Losing the tie takes that decision away from whoever wrote the `nix.conf`.

**A NAR on an S3 store is a 307**, to a presigned URL good for ten minutes, and the client re-sends its own `Range` there; a disk store streams it from odu. See [A NAR is a redirect](#a-nar-is-a-redirect). The same three protocol files also sit in the store itself (`<bucket>/nix-cache-info`, `<bucket>/<hash>.narinfo`, `<bucket>/nar/<file>`), which is what lets a public bucket be read from the store's own domain with odu switched off.

On a bucket's own domain the same four Nix paths sit at `/`: `/nix-cache-info`, `/<hash>.narinfo`, `/nar/<file>` and their uploads. `Host` names the bucket.

`/cache` is a literal, and it is load-bearing: the board answers `/assets/<hashed
bundle>` on the same origin, and a bucket at the origin's first segment would
shadow the page's own JavaScript. A bucket called `cache` lives at
`/cache/cache`.

Writes, and reads of private buckets, accept `Authorization: Bearer <token>` or HTTP Basic with any username and the token as the password. Nix uses the second through curl on every request, uploads included. The `missing` route backs `odu cache push`; it is not part of the Nix protocol. It answers `missing` — the paths to send — and `skippedUpstream`, the paths the bucket will never take because an upstream key signed them, so a push can report the two as different things.

The three `upload` routes are the 2.9 negotiation (cache surface **4.2**): the client asks where a NAR's bytes go, and an S3-backed bucket answers `{mode:"direct", upload, partSize, part}` — part 0's presigned URL at the store, with the rest signed one at a time — while a disk-backed one answers `{mode:"staged"}`, which means the plain `PUT …/nar/<file>` above. Every byte of a direct upload is a part of ONE multipart upload, so completing it leaves the key with no writer odu ever signed for. The narinfo PUT still decides: odu reads the uploaded object back out of the store, verifies it and copies it into place before it records anything. An origin too old to answer the negotiation is refused by name rather than quietly given the old path.

The `pin` route is the one pin verb outside the administrative surface, and it takes write scope rather than admin on purpose: a write token can already keep any closure alive forever by pushing it again, because a stored push renews a path's `lastWanted`. A pin it creates makes that same promise once instead of nightly, and it reads nothing and deletes nothing.


Re-pointing a pin releases whatever that pin held before, so the line is drawn by who made it — `createdBy`, which `pin_list` shows. A write token may re-point a pin a write token made, and never an administrator's: a leaked CI token, or a typo in a workflow's `pin:`, must not drop `release-1.0`. Write tokens of one bucket are peers here, as they already are in pushing to it. Deleting a pin stays an administrator's either way.

### The cache describes itself

`nix-cache-info` carries two lines beyond the three a Nix client reads, in both spellings of it and in the copy the store holds:

```text
Odu-Origin: https://odu.example.com
Odu-Bucket: main
```

`Odu-Origin` is the daemon a push is taken by — never the name the reader arrived on, which may be a store's domain or a CDN that answers `GET` and nothing else — and `Odu-Bucket` is which bucket that substituter serves. Nix ignores keys it does not know, so a reader is unaffected; `odu cache push --cache <substituter>` and [the push action](#push-from-github-actions) are what read them, which is how a consumer repository holds one fact about its cache instead of three.

The object in the store is rewritten whenever that text changes — a move behind a new public origin — by the same boot pass that backfills narinfos, compared by the stored sha256 rather than by length, and the address it was cacheable at is purged at the edge.

**Naming a cache is trusting it.** `--cache` sends your write token to the substituter you named (a private bucket's `nix-cache-info` answers nobody without it) and then pushes to whatever origin that file states, so a cache you do not control — or a DNS or CDN compromise in front of one — is a cache you have handed the token to. Name a substituter you trust, as you already do in `nix.conf`.

## Command reference

The CLI keeps the four cache commands a shell is the natural place for. Everything else is the board or the API verb — `odu surface cache <verb> --input '{…}' --json`, with `rootToken` a field of the input.

| What it does | CLI | API verb | On the board |
| --- | --- | --- | --- |
| Print the substituter and key settings, the `nixConfig` block, and the netrc lines. No account for a public bucket | `odu cache use <bucket>` | `bucket_describe` | a bucket page's block |
| Save a token for an origin in `~/.config/odu/cache/credentials` | `odu cache login <origin>` | — | — (a machine's disk) |
| Upload only the paths the bucket is missing; the bucket keeps what it takes. `--cache <substituter>` reads the origin and the bucket off the cache's own `nix-cache-info` instead of being told them. `--pin NAME` re-points that pin at the closure this push landed, unless a path was refused | `odu cache push <bucket> <paths…> [--part-size MiB] [--pin NAME]`, or `odu cache push --cache <substituter> <paths…>` | — | — (a build box's job) |
| Print the one odu substituter `./flake.nix`'s `nixConfig` names, and nothing else (`-o json` → `{cache, origin, bucket}`). The push action resolves an omitted `cache:` with it | `odu cache target` | — | — (reads this checkout) |
| Create a bucket; answer its substituter URL, public key and store. `retentionDays` is how long it keeps what nobody wants (90 when absent). `upstreamKeys: []` takes everything, including upstream-signed closures (costs disk; for consumers that cannot reach cache.nixos.org). `store` keeps its objects in a declared store (default `local`) | — | `bucket_create` | Cache → **Create bucket**, **Skip upstream paths** off, the **store** field |
| List buckets | — | `bucket_list` | Cache |
| Give a bucket a DNS name of its own, or take it away (omit `domain`) | — | `bucket_domain` | bucket → **Domain** |
| Change how long a bucket keeps what nobody wants | — | `bucket_retention` | bucket → **Retention** |
| Move a bucket's objects to another declared store; answers the row, and `migration` on it is the progress. Serves from the old store until the copy is done | — | `bucket_migrate` | bucket → **Move to another store** → **Start move** |
| Delete a bucket: its objects out of its store first, then the bucket, its paths, its pins and the tokens scoped to exactly its name. Answers the objects removed and their bytes. Refused while a domain is bound to it or a move is in flight | — | `bucket_delete` | bucket → **Delete this bucket** |
| Mint a token, answered once (`scope`: `read`, `write` or `admin`) | — | `token_mint` | bucket → **Mint token** (write or read) |
| List tokens with scope, expiry and last use | — | `token_list` | bucket → Tokens |
| Revoke one token | — | `token_revoke` | bucket → Tokens → **revoke** |
| Pin a closure against garbage collection; a name that exists is re-pointed | — | `pin_create` | bucket → **Pin closure** |
| What each pin holds, and who made it | — | `pin_list` | bucket → Pins |
| Let a pin go | — | `pin_delete` | bucket → Pins → **unpin** |
| What the next collection would take, without taking it. `retentionDays` plans at a retention of your own (absent is the bucket's; `0` is what nothing references and no pin holds), and writes nothing — `gc_run` has no such field | — | `gc_plan` | bucket → **Dry run**, and the **retention** field beside it |
| Evict objects past retention that nothing references and no pin holds — the daily pass, asked for now | — | `gc_run` | bucket → **Run GC** |
| Show storage and hit counts | — | `stats_read` | a bucket's facts line, drawn from the bucket's own published row |
