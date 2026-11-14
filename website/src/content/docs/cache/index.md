---
title: Nix binary cache
description: Serve a Nix binary cache from odu: create a bucket, point Nix at it, and read a private bucket.
section: Binary cache
order: 0
---

`odu web` also serves Nix binary caches. It speaks the standard Nix HTTP binary cache protocol, so every Nix client works unchanged. A **bucket** is one cache: one substituter URL under the service's origin, and one public key the service signs with.

Commands are written with the [`odu` shorthand](/docs/#quick-start).

## Create a bucket

```sh
odu surface cache bucket_create --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","name":"main","public":true,"retentionDays":30}' --json
```

On the board, an admin creates one under **Cache** → **New bucket** → **Create bucket**. The CLI has no command for it.

| Input | Board control | What it sets |
| --- | --- | --- |
| `name` | **name** | the bucket's name, in its URL |
| `public` | — (the board creates public buckets) | whether anyone may read it without a cache token |
| `retentionDays` | — (set it afterwards under **Retention**) | how long it keeps what nobody wants. 90 when absent. See [Keep and reclaim](/docs/cache/retention/). |
| `upstreamKeys: []` | **Skip upstream paths**, switched off | keep paths an upstream key signed too. Switched on, the default, the bucket skips paths `cache.nixos.org-1` signed. |
| `store` | **where its objects live** | a declared S3 store. See [Keep a bucket on S3](/docs/cache/s3/). |

`bucket_create` returns the substituter URL and the bucket's public key. Behind a proxy, the URL is under the address you published the service at, `$ODU_PUBLIC_ORIGIN`, which the NixOS module derives for you.

## Use it

Trust the key, and a build substitutes from the bucket instead of building. The bucket's **Set up** block on the board shows each setting in its own tab, and `odu cache use main` prints them in a terminal.

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

GitHub Actions, inside the step that installs Nix:

```yaml
extra_nix_config: |
  extra-substituters = http://127.0.0.1:18440/cache/main
  extra-trusted-public-keys = main-1:<public-key>
```

A private bucket's **Set up** block also has the netrc lines, because reading it needs a cache token:

```sh
# netrc — an absolute path, no ~
netrc-file = <home>/.netrc
machine 127.0.0.1:18440 password <your-read-token>
```

`odu cache use` needs no account for a public bucket, because a bucket's URL and public key are what it publishes to every client. It reads them from `GET /cache/<bucket>/`, which also returns a small page for `curl`, or JSON with `Accept: application/json`.

## Private buckets

A public bucket is read without a cache token. A private bucket is read with a cache token of read scope or wider, and every write needs one.

| Client | How it sends the cache token |
| --- | --- |
| `nix copy`, substitution | the netrc lines above |
| any HTTP client | `Authorization: Bearer <token>` |

- An anonymous read of a private bucket returns 404, and a wrong, revoked, expired or other bucket's cache token returns 403. [How the cache works](/docs/cache/how-it-works/#why-a-private-bucket-answers-404) says why.
- `odu cache use` on a private bucket, without a credential, is refused: "if it is private, sign in (`odu auth login`) or set $ODU_TOKEN to a read token". With `$ODU_TOKEN` set to a read token, it prints the block.

## The Cache view

`odu web`'s page has **Runs** and **Cache** in the header. `#/cache` lists the buckets — name, public or private, how many paths, how much space, when it last took a push, how many reads — and `#/cache/<bucket>` is one bucket: its substituter URL, its public key, the `nix.conf` / netrc block above ready to copy, and its paths as a table of **name · hash · size · pushed · reads · commit · run · wanted · kept by**. The facts line says who answers a read of it — **reads served from cache.example.com**, or **reads served by odu**.

**The paths table is grouped by name by default**, because a bucket is mostly one package over and over: `odu-base-0.1.0` with six builds in it is one row carrying the count, their total size, the newest push and the summed reads — **counted by the row over the whole bucket**, not over the page on screen (`cache_bucket_paths` takes `group: "name"`, and opening a row reads that package's versions with `name`, and its own **show N more** pages within the group from the same cursor). Press **group by name** to turn it off for a row per path. Click **name**, **size**, **pushed** or **reads** in the header to order by it (again to reverse; the header says which way, and so does `aria-sort`) — the order and the paging are the row's too, so **Show 20 more** continues the same order rather than re-sorting what arrived. The filter box narrows what the bucket answers, and a hash is the first eight characters, with the whole store path in its `title` and on the clipboard when you click it.

**The view does everything the cache row serves**, except push, which is a build box's job — and since the admin CLI retired, the view and `odu surface cache <verb>` are the two ways to administer a bucket. Anyone may read: the page asks `cache_bucket_describe` and `cache_bucket_paths`, which take no credential, because a bucket's URL, its key and its path list are what the substituter already publishes. An admin is also drawn the administration: **Create bucket** (with **Skip upstream paths** — off is `upstreamKeys: []`) on the list, and on a bucket page a **Pins** tab beside **Paths** (pin a closure; what each pin holds, roots folded behind *what it holds* with a **show all** when there are more than the row draws; delete one) and a settings column — **Tokens** (mint write or read, shown once; list; revoke), **Retention**, **A name of its own**, **Move to another store**, **Garbage collection** (**Run GC**, and a **Dry run** with its own **retention** field beside it, which the button says back: *Dry run at 0 days*) and, behind a **Danger zone** rule, **Delete this bucket** — which asks you to type the bucket's name before its button will do anything, and goes solid red once you have, returning to the list when the bucket is gone. The dry run is asked for rather than taken on arrival, and is asked again after every collection — "what am I about to lose" is a question a report answers too late, and a question nobody asked must not answer in red. The retention field is the dry run's alone: blank is the bucket's own (the placeholder says which number that is), and nothing you type there changes what the bucket keeps or what **Run GC** would evict. The controls are drawn by role and refused by the row on its own, so a hidden button is never the only check.

The bucket rows arrive over the wire the page already holds, so a push from a build box moves a bucket's counters — on the list and in its facts line — without a reload; reads are folded into those counters at most once a second rather than once per NAR. The path list and the pin list are pages read when you open them, which is what **refresh paths** and **refresh pins** ask again.

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

**A NAR on an S3 store is a 307**, to a presigned URL good for ten minutes, and the client re-sends its own `Range` there; a disk store streams it from odu. See [A NAR is a redirect](#a-nar-is-a-redirect). The same three protocol files also sit in the store itself (`<bucket>/nix-cache-info`, `<bucket>/<hash>.narinfo`, `<bucket>/nar/<file>`), which is what lets a public bucket be read from the store's own domain with odu switched off.

On a bucket's own domain the same four Nix paths sit at `/`: `/nix-cache-info`, `/<hash>.narinfo`, `/nar/<file>` and their uploads. `Host` names the bucket.

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
| Upload only the paths the bucket is missing; the bucket keeps what it takes. `--cache <substituter>` reads the origin and the bucket off the cache's own `nix-cache-info` instead of being told them. `--pin NAME` re-points that pin at the closure this push landed, unless a path was refused. `--run ID` and `--commit SHA` state what built the paths (see [Push](#push)) | `odu cache push <bucket> <paths…> [--part-size MiB] [--pin NAME] [--run ID] [--commit SHA]`, or `odu cache push --cache <substituter> <paths…>` | — | — (a build box's job) |
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

## Find your page

| You want to | Read |
| --- | --- |
| <span id="tokens"></span>mint, list or revoke a cache token | [Tokens](/docs/cache/tokens/) |
| <span id="push"></span>push paths to a bucket | [Push](/docs/cache/push/) |
| <span id="push-from-github-actions"></span>push from a GitHub workflow | [Push from GitHub Actions](/docs/cache/github-actions/) |
| <span id="keep-and-reclaim"></span>keep a closure, see why a path is still here, or collect garbage | [Keep and reclaim](/docs/cache/retention/) |
| <span id="keep-a-bucket-on-s3"></span>keep a bucket's objects on R2 or another S3 store | [Keep a bucket on S3](/docs/cache/s3/) |
| <span id="a-domain-for-a-bucket"></span>give a bucket a domain of its own | [A domain for a bucket](/docs/cache/domain/) |
| <span id="reads-leave-odu"></span>understand why reads go to the store, and other choices | [How the cache works](/docs/cache/how-it-works/) |
| <span id="where-the-data-lives"></span><span id="operating-it"></span>find the files, size the disk, back up, or read the log | [Operate the cache](/docs/cache/operations/) |
| <span id="protocol"></span>write a client against the cache's routes | [Protocol](/docs/cache/protocol/) |
| <span id="command-reference"></span><span id="the-cache-view"></span>look up a cache command, API verb or board control | [Command reference](/docs/cache/reference/) |
