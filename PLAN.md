# Odu as a product: Nix cache + CI you run yourself

Status: living, 2026-11-02.
- Phase 1 and phases 2.1–2.4 are on master.
- **Next is 2.5**, the staging fix.
- One step is one PR, and the order is a dependency order. There is no schedule.

## Contents

1. [Positioning](#positioning)
2. [Decisions](#decisions)
3. [Architecture](#architecture)
4. [Roadmap](#roadmap)
   - [Phase 1: foundations](#phase-1-foundations) ✅
   - [Phase 2: the cache as a product](#phase-2-the-cache-as-a-product) (2.1–2.4 ✅)
   - [Phase 3: teams](#phase-3-teams)
   - [Phase 4: CI pushes for you](#phase-4-ci-pushes-for-you)
   - [Phase 5: hosted CI](#phase-5-hosted-ci)
   - [Phase 6: scale and hosting](#phase-6-scale-and-hosting)
5. [Risks](#risks)
6. [Appendix: facts the plan rests on](#appendix-facts-the-plan-rests-on)
7. [Appendix: old PR names](#appendix-old-pr-names)

## Positioning

Odu began as "live CI for `just` pipelines": a per-user loopback service with a
web board, CLI and MCP faces, SSH lane hosts and GitHub statuses.

**The product:** the Nix binary cache and CI that teams run on their own
hardware, and that we can host for them. It is one service with one board:

| Pillar | What it means |
| --- | --- |
| **Cache** | Per-team buckets, revocable tokens, server-side signing, and GC that never deletes a live closure. It speaks the plain Nix HTTP protocol. |
| **CI** | The `just` DAG runner, triggered by forge webhooks, that pushes every built path to the team's bucket. No push step appears in any workflow. |
| **Board** | Runs and cache in one UI: which run built a path, hit rates, storage per team, and agent access over MCP. |

Odu is AGPL. It runs as one NixOS module on one machine, or as cache nodes on
object storage plus a lane pool. Hosting comes later, at a monthly price.

| Against | They are | We are |
| --- | --- | --- |
| Cachix | Closed, "contact sales", a push step per workflow | AGPL, self-hosted or hosted, CI pushes for you |
| Attic | Unrevocable JWTs, no pins, no UI or login[^chutney] | Revocable tokens, pins, GitHub login, team UI |
| niks3 | Single cache, S3 only, no CI | Multi-tenant, disk or S3, CI included |
| FlakeHub Cache | Not self-hostable, Actions only | Self-hostable, any CI |
| garnix / Hercules | Hosted, or a hosted coordinator | Fully on-prem possible |

## Decisions

- **Own data plane**, in TypeScript/Bun in this monorepo. Odu does not wrap
  Attic, celler or niks3.
- **Pushes come from a post-build hook** on lane hosts. Explicit push is the
  fallback.
- **Identity is a GitHub App.** Personal tokens cover non-humans; OIDC
  (Google) comes later for internal teams.[^identity]
- **CI is triggered by forge webhooks**, and the CI-tagged justfile stays the
  pipeline.
- **Hosting v1 is one process on one machine.** It ships as the
  `services.odu` NixOS module, and our own deployment is a K3s pod where every
  PR is dogfooded.[^pod]
- **Identity before public exposure.** The board cannot face the internet
  before odu knows who is asking.
- **The web face and web API are the product.** A verb that exists only in the
  CLI is a defect. The CLI stays only where a shell is natural: a push from CI,
  the hook, and `odu run`.[^parity]
- **First users:** OSS projects, then internal teams. Migration from Attic is
  out of scope.
- **Buckets are free-form names under an org**, any number per org. A bucket
  may link to a repo, for provenance.
- **Retention defaults to 90 days** from the last push that named a path. Pins
  are exempt, and each bucket can override the default.
- **`kolu` moves to R2** once reads leave odu (2.8), so `cache.kolu.dev` stays
  up when the pod is down.
- **The hosted offering is in scope** (Phase 6).

## Architecture

```
            ┌──────────── odu host (one process) ────────────┐
 browser ──►│ auth row │ ci row │ cache row │ cloudflare row │
 MCP/CLI ──►│   sign-in, sessions, tokens → Principal         │
            └──────┬──────────┬───────────┬──────────────────┘
                   │          │           │
              lanes (SSH)  catalog    ObjectStore: local disk | any S3 (R2 …)
```

- **Rows behind one host.** `auth`, `ci`, `cache` and `cloudflare` are Cordis
  rows. Each owns its surface, server, CLI and face, and versions its own
  contract. Only the host names rows.[^rows]
- **The cache is a standard Nix binary cache**, per bucket.[^protocol]
  - Narinfos are signed on ingest with the bucket's own key, so pushers never
    hold a key.
  - Public buckets read anonymously; writes and private reads take a token,
    over Bearer or netrc.[^creds]
- **The bytes are objects, not a Nix store.** Each pushed `.nar.zst` is
  stored once.
  - `@odu/objects` keeps it on local disk or any S3-compatible store; a bucket
    names its store when it is created.
  - SQLite holds the metadata.[^storage]
- **Server mode.** The host owns "who is on this connection" and the `auth`
  row supplies it. Sessions are leases, so revoking one cuts its sockets. Roles
  are each row's own rule.[^server]
- **Push paths, in order of preference:**
  1. the hook (Phase 4.1);
  2. `odu cache push` or the GitHub Action, from anywhere (landed);
  3. run-scoped push (Phase 4.2).
- **Deployment shapes:**

  | Shape | What it is |
  | --- | --- |
  | Small team | One NixOS machine as cache, board and lane |
  | Ours | The pod, plus tailnet lanes |
  | Large team | Cache nodes on S3 and Postgres, plus a lane pool |
  | Hosted | The large shape, multi-org and metered |

## Roadmap

**Rules for every step:**
- It is substantial, and it merges green with evidence.
- It leaves master runnable.
- A capability reaches the public surface only in the step that completes it.

### Phase 1: foundations

✅ All landed. Odu became a multi-row host with GitHub sign-in and full
web-face parity.

| | Step | PR | What master gained |
| --- | --- | --- | --- |
| 1.1 | The caller and the forge | #130 | `Caller` built once per call; the forge as a port |
| 1.2 | A Nix binary cache | #132 | Buckets, signing, scoped tokens, GC with pins, `services.odu` |
| 1.3 | A host and its rows | #133 | `@odu/host` and Cordis rows; the cache got its own faces |
| 1.4 | Server mode | #134, #137 | The `auth` row: GitHub App sign-in, sessions as leases, roles |
| 1.5 | The web face has every verb | #136 | Every verb has a control on the board |
| 1.6 | Each row versions its own surface | #141 | Per-row contract versions; kolu admits on `ci` alone |

### Phase 2: the cache as a product

**Goal:** a cache that is fast, cheap and correct on any store, with odu off
the read path wherever it can be, behind a board people want to use.

| | Step | State |
| --- | --- | --- |
| 2.1 | The cache serves itself | ✅ #138 |
| 2.2 | The object cache | ✅ #139, #140 |
| 2.3 | Push from GitHub Actions | ✅ #142 |
| 2.4 | Object storage | ✅ #143 |
| 2.5 | Staging never refuses a valid NAR | next |
| 2.6 | The board, redesigned | |
| 2.7 | GC and pins on every store | |
| 2.8 | Reads leave odu | |
| 2.9 | Uploads go straight to the store | |
| 2.10 | The admin CLI is retired | |

What each step delivers:
- **2.1 ✅** `cache.kolu.dev` is live through a Cloudflare tunnel, with no open
  port, and odu's CI pushes to it.
- **2.2 ✅** The pushed NAR is kept and served as is, with ranges. `CA:` is
  proved, and memory per NAR is constant.
- **2.3 ✅** One workflow step pushes a closure and goes red if a path doesn't
  answer.[^action]
- **2.4 ✅** A bucket lives on local disk or any S3 store (R2, AWS, Garage),
  and one contract suite proves both.[^objects] It's measured on the pod.[^bench]
- **2.5 Staging never refuses a valid NAR.** Staging refuses some valid NARs
  with `zstd exited 1`: under concurrent pushes, and every time for one small
  fixed-output path.[^zstd] Find the root cause and fix it, and add a
  regression test for both cases. A cache that refuses valid paths comes
  before every feature.
- **2.6 The board, redesigned.** One PR that ships the "Night shift" design
  system and moves every existing screen onto it.[^board]
  - **Theme:** dark by default and light from the same tokens. It follows the
    OS setting, with a toggle.
  - **Screens with an approved design:** runs, a run, the cache, a bucket, and
    sign-in.
  - **Screens the implementor designs in the same language:** machines and
    holds, tunnel status, people and roles, and the profile with personal
    tokens. They are reviewed in the PR.
  - Screens for later features (GC and pins, starting a new run) land inside
    the steps that add those features, built in this design.
- **2.7 GC and pins on every store.** Liveness comes from pushes, not reads,
  because reads are about to leave odu. GC is written only against
  `ObjectStore`, and deletions purge the CDN.[^gc] The bucket page dry-runs the
  next collection.
- **2.8 Reads leave odu.** Today every byte crosses the odu machine's uplink,
  and on the pod that caps reads at ~2.5 MiB/s.[^bench]
  - **Public bucket:** plain static files (narinfos, NARs, `nix-cache-info`)
    on the store's public URL or CDN, so the cache stays up when odu is down.
  - **Private bucket on S3:** odu authorises, then redirects the NAR to a
    presigned URL that expires in 10 minutes.
  - **Local disk:** odu serves the same layout.
  - `odu cache migrate` moves buckets between stores, and `kolu` moves to R2.
    It is an API verb and a board control, not a CLI command (2.10).
  - **Proof:** the pod at zero replicas still substitutes kolu.[^reads]
- **2.9 Uploads go straight to the store.** The client uploads to the store
  through presigned parts. Odu then reads the object back and verifies it
  before signing. That is Cachix's upload, but without Cachix's trust in the
  client's hashes.[^uploads]
- **2.10 The admin CLI is retired.** The board and the API are the product, so
  the CLI keeps only what needs a shell on the machine that holds the paths or
  the checkout: `odu ci …`, `odu cache use|login|push`, `odu auth login`, and
  the service itself. Every administrative verb is a control on the board and
  a verb on the API, proved one by one before it is removed.[^retire]

### Phase 3: teams

- **3.1 Orgs.** Teams self-serve without the operator:
  - membership synced from GitHub, roles, many buckets per org;
  - private buckets;
  - quotas, token revocation and an audit log.[^teams]

### Phase 4: CI pushes for you

- **4.1 The hook.** Every build on a configured lane lands in the bucket, with
  no step in any recipe. A cache outage only queues paths. The host owner
  installs the hook, so lanes still hold no credentials.[^hook]
- **4.2 Run-scoped push and provenance.** `odu run --push` pushes with a token
  that lives as long as the run. A cached path links back to the run and
  commit that built it, and a recipe can pin its closure.[^runpush]

### Phase 5: hosted CI

- **5.1 Repositories and org-scoped venues.** Odu keeps its own clones and
  runs any SHA without a developer checkout. Lanes belong to the org.[^repos]
- **5.2 Webhooks and check runs.** Installing the App gives checks on every
  push and PR with no workflow file. Actions jobs push with an OIDC-exchanged
  token instead of a stored secret.[^webhooks]
- **5.3 Bitbucket** and **5.4 Jenkins**, each one adapter over 5.2's port: a
  source event in, a status out.

### Phase 6: scale and hosting

- **6.1 Postgres.** Several odu servers share one database behind one domain.
  SQLite stays the default.
- **6.2 Metrics.** `/metrics` exposes hit rates, storage, run durations and
  lane use.
- **6.3 Metering.** Per-org storage, transfer and build minutes, with limits
  and an export for billing.

## Risks

| Risk | Mitigation |
| --- | --- |
| Credentialed `nix copy` varies by Nix version | `odu cache push` is the supported path; Basic auth for Lix and newer Nix |
| The first database in the tree | A small repository layer, so Postgres (6.1) is a swap |
| Server mode touches every verb | Loopback mode's unchanged tests are the regression guard |
| One box serving many developers | Reads leave odu in 2.8 |
| Run-scoped push relaxes "lanes hold no credentials" | Scoped, write-only, run-lifetime tokens; the hook stays recommended |
| No chunking | Deliberate[^chutney]; revisit only if storage cost dominates |
| Bun streaming backpressure | Measured, not assumed[^bun]; 2.8 takes odu off the read path anyway |

## Appendix: facts the plan rests on

Each fact was checked in the source when it was written.

| | Fact | Consequence |
| --- | --- | --- |
| F1 | `odu web` serves through kolu's `serveSurfaceApp`, which has route, middleware and per-connection service seams[^f1] | Cache routes and the principal are layers, so kolu needs no change |
| F2 | Without `auth`, whoever reaches the listener is the owner | Loopback mode is the regression guard |
| F3 | The cache's SQLite is the only database; runs live in per-user files | Postgres is the cache's swap alone |
| F4 | Every public command is a client of the service (`authority.test.ts`) | `odu cache push` is admissible: it is an HTTP client of the cache |
| F5 | `post-build-hook` is a Nix daemon setting; lane provisioning never edits `nix.conf` | The hook is host configuration (4.1) |
| F6 | Lane hosts never see credentials; GitHub posting happens on the coordinator | 4.2 relaxes this, bounded |
| F7 | A run needs an absolute checkout on the service's machine | Hosted CI needs managed clones (5.1) |
| F8 | Hosts are per user (`hosts.json`) | Org-scoped venues (5.1) |
| F9 | The flake exports odu, the runner, the web UI and `services.odu`; its `nixConfig` names `cache.kolu.dev` | Odu is its own cache's first consumer |
| F10 | Every client takes `--origin`; remote dialling exists | Remote clients need only authentication |
| F11 | odu's CI builds on Linux and macOS and pushes with the 2.3 action | The cache is dogfooded on every push to master |
| F12 | Our deployment is a pod with no nginx, behind Tailscale and a Cloudflare tunnel[^pod] | Identity had to come before a public cache |
| F13 | Rows sit behind one fence: only roots name rows (`fence.test.ts`) | Identity is the host's fact plus the `auth` row |

## Appendix: old PR names

Commits and PR bodies use the earlier names.

| Old | New | | Old | New |
| --- | --- | --- | --- | --- |
| PR 0 | 1.1 | | PR 3c2 | 2.7 |
| PR 1 | 1.2 | | PR 3d | 2.8 |
| PR 1.5 | 1.3 | | PR 3g | 2.9 |
| PR 2 (+hotfix) | 1.4 | | PR 4 | 3.1 |
| PR 2.5 | 1.5 | | PR 5, 6 | 4.1, 4.2 |
| PR 3e | 1.6 | | PR 7, 8 | 5.1, 5.2 |
| PR 3a | 2.1 | | PR 9, 10 | 5.3, 5.4 |
| PR 3b (+fix) | 2.2 | | PR 11 | folded into 2.4–2.9 |
| PR 3f | 2.3 | | PR 12 | 6.1 |
| PR 3c | 2.4 | | PR 13, 14 | 6.2, 6.3 |

[^chutney]: chutney's Attic: 669 GB on S3 and 46 GB of Postgres, growing
    without bound with GC off. Its chunking cost more than it saved on S3.

[^identity]: Sign-in uses the App's authorisation-code flow (1.4). Installation
    tokens arrive in 3.1 (membership sync) and 5.2 (checks). Expiring user
    tokens are refused until 3.1 stores refresh tokens.

[^pod]: nixos-config `k8s/apps/odu` runs `odu web` in `pureintent`'s K3s: one
    replica, with a `local-path` PVC for the catalog and objects. It publishes
    `https://odu-k3s.rooster-blues.ts.net` over Tailscale Serve, and the cache
    is public through the cloudflare row's tunnel. The root token, the GitHub
    App and the R2 keys come from 1Password through External Secrets.
    `ODU_CACHE_STORE` remains only so 2.2's migration can dump the old 166 GB
    store; it is deleted after `cache.migration.complete`. The bucket `kolu` is
    `--no-upstream`, so the runner's published closure imports with no trusted
    key. The pod currently runs #143's head `6df8c8e`, with test buckets
    `r2test` (R2, bucket `odu-test`) and `localtest` (disk).

[^parity]: Parity is checked by each row's own e2e: one scenario per verb,
    driven through the face.

[^retire]: What 2.10 does, row by row.
    - **Kept, because a shell is the only place they can run:** `odu ci …`
      (a run is about THIS checkout), `odu cache push` (it runs where the store
      paths are), `odu cache login` and `odu auth login` (a credential is a file
      on this machine), `odu cache use` (it prints lines for this machine's
      `nix.conf` and netrc), and the service entry points `odu web`,
      `web-daemon`, `odu surface`, `odu mcp`.
    - **Retired:** every bucket, token, domain, pin, GC and stats verb under
      `odu cache`; everything under `odu auth` but `login`; `odu cloudflare`
      entirely, so that row's `./cli` door is gone.
    - **The runs move under their row's word.** `odu run` is `odu ci run`,
      `odu wait` is `odu ci wait`, and so on for all fifteen: a row owns its
      verbs, and the root names rows. No aliases — two spellings of one verb is
      the drift this removes.
    - **Removal needs proof, one command at a time:** a web control AND a verb
      on the API, listed in the PR against the command they replace. A gap is a
      refusal to remove, never a silent drop.
    - `odu surface` had hand-listed the cache as its only sibling, so the
      `auth` and `cloudflare` verbs were reachable by MCP and from no terminal
      at all. It now projects every row the wire knows.

[^rows]: Cordis per olai `docs/architecture/cordis.md`. `@odu/cordis` holds the
    shared contract. `packages/host/src/fence.test.ts` proves, with
    `@olai/effect-cordis/fence`, that only roots name rows. Versions: host 2.5,
    `ci` 2.4, `cache` 3.1, `auth` 2.4, `cloudflare` 2.4. Each row is held to an
    append-only fingerprint ledger by `just test`, and `admitService` admits a
    client on the rows it declares.

[^protocol]: Routes per bucket:
    ```
    GET  /cache/<bucket>/nix-cache-info
    HEAD /cache/<bucket>/<hash>.narinfo
    GET  /cache/<bucket>/<hash>.narinfo
    GET  /cache/<bucket>/nar/<narHash>.<ext>     Content-Length, Range
    PUT  /cache/<bucket>/nar/<narHash>.<ext>     chunked under a proxy's body cap
    PUT  /cache/<bucket>/<hash>.narinfo          re-signed with the bucket key
    POST /_odu/v1/buckets/<bucket>/missing       batch query; drops upstream-signed paths
    ```
    A bucket domain is answered by `Host`.

[^creds]: `odu cache push` takes its token from `--token-file`, then
    `$ODU_CACHE_TOKEN`, then `odu cache login`'s credentials file. Nix reads
    only its `netrc-file` setting, never `~/.netrc`, so `odu cache use` prints
    both lines. CI can put the token in the URL instead.

[^storage]: `ObjectStore` offers `put`, `get(range)`, `head`, `facts`, `delete`,
    `list` and `sweepTemp`, plus disk's optional `link`. Keys are opaque, and
    facts are a size and a hex sha256. The cache owns the key layout and the
    one hex ↔ `FileHash` conversion (`packages/cache/src/fileHash.ts`).
    - Put-if-absent: disk uses `link`; S3 uses `If-None-Match: *` plus a
      per-key queue. `412` means lost; `409` is retried.
    - Stores are declared in `services.odu.cache.stores` (env
      `$ODU_OBJECT_STORES`, credentials from a file).
    - The boot sweep removes orphans, `.tmp-*` objects and incomplete multipart
      uploads.
    - `CA:` is served only when `contentAddressOf` reproduces the row's path.
    - On disk under the state directory: `cache/cache.sqlite`,
      `cache/objects/` and `cache/staging/`. The database and the stores are the
      backup.

[^server]: The `Principal` broker lives in `@odu/cordis`; with no resolver, every
    connection is the local owner. The `auth` row registers its resolver on a
    single-owner key. Each session is a lease taken at upgrade. An ended lease
    refuses every member, including the `system/live` heartbeat, and
    `SurfaceAppConnection.close` (kolu #2330) cuts the socket. The root token
    is the operator's bootstrap; it only grants the first `owner`.

[^action]: `uses: juspay/odu/.github/actions/push@<sha>` builds its pusher from
    the action's own checkout. With no token on a PR it pushes nothing; with no
    token on a push it fails. Each path is verified at the bucket's
    substituter URL: the narinfo, and the NAR's `Content-Length` against
    `FileSize:`. The results come from `odu cache push --output json`
    (`served`, `substituter`) and appear as a step-summary table.

[^objects]: S3 reads have no HEAD: the row knows the size, and the first ranged
    GET answers absence. Reads come in 1 MiB windows with one prefetched into
    a buffer, because Bun's fetch body applies no backpressure. Every window
    is held to its range length. Parts upload four at a time from reused
    buffers. R2 honours `If-None-Match` on `PutObject` (412, measured) but
    doesn't document it on `CompleteMultipartUpload`, so objects over 8 MiB
    are put-if-absent within one daemon only.

[^bench]: Pod at #143 (`6df8c8e`). The same client and tailnet path for both:

    | | local disk | R2 |
    | --- | --- | --- |
    | push 33 MiB fresh (median of 3) | 13.8 s (was 22.0) | 17.6 s (was 27.9) |
    | first byte, 20 MiB NAR | 0.09 s | 0.19 s (was 0.45) |
    | throughput, 20 MiB NAR | 2.5 MiB/s | 2.3 MiB/s |
    | read 46 kolu paths, 641 MiB (median of 3) | 267 s (was 333) | 266 s |

    Both stores read at the same rate (267 s against 266 s), so the home uplink
    bounds reads, not the store. Every R2 byte crosses that uplink twice: R2 → pod → client.

[^board]: The design is a private claude.ai Design canvas:
    https://claude.ai/artifact/7WM9HNSjiX3Uku55ZrMMZc (five artboards).
    - **Direction:** a near-black ground (`#0A0D0C`), Geist for text and Geist
      Mono for anything a person copies or compares (hashes, store paths,
      keys, durations).
    - **Colour carries status only:** green ok, amber running, red failed,
      cyan links.
    - **Signature element:** a lane strip, one cell per lane, on the board and
      on each run.
    - **Fonts are bundled with the web UI**, not loaded from Google Fonts. A
      tailnet-only or air-gapped deployment must render the same.
    - **Where it lives:** the tokens and shared primitives go in `@odu/face`
      (beside `./control` and `./refusal`), so every row's face uses them, and
      each row still draws its own screens (Cordis). It is Solid, reviewed
      against /solidjs.
    - **Layout:** the canvas is drawn at 1440 px. Every screen must work down
      to phone width with no horizontal scroll, and each row's e2e covers
      every verb through the new face.

[^gc]: `lastWanted` replaces `lastAccessed`. It is renewed by the `missing`
    query and by a stored push. GC uses `list`/`delete`, with #140's
    live-rows re-check under the bucket lock. Deletions announce their URLs
    through a cordis port, which the cloudflare row purges; the cache row never
    names Cloudflare. The contract suite gains GC and pin cases, run on disk and
    on S3.

[^zstd]: `narinfo upload answered 400: nar/<hash>.nar.zst: zstd exited 1`. It
    happens under concurrent pushes, and deterministically for the 2 KB
    fixed-output path `exec-path.c`: `localtest` refused it twice, `r2test`
    accepted it. The evidence is on #142 and #143.

[^reads]: How 2.8 works:
    - At push, odu writes `<hash>.narinfo` and `nar/<file>` as objects with
      `Cache-Control`. NARs are immutable. Narinfos have a long TTL and are
      purged on a re-push, delete or key rotation. A key rotation rewrites
      every narinfo.
    - A bucket's substituter URL is its store's public URL, and the cloudflare
      row binds the domain to the R2 bucket instead of the tunnel.
    - Private-bucket redirects rely on Nix following them
      (`CURLOPT_FOLLOWLOCATION`) and on curl dropping `Authorization` when the
      host changes. The e2e must prove both.
    - What odu gives up: `cache.nar.served` logs a redirect, not bytes.
    - Precedent: Attic answers `307` to a 10-minute presigned URL for
      single-chunk NARs only, and stitches multi-chunk ones through the server
      (`server/src/api/binary_cache.rs`). Cachix serves NARs from a CDN. Odu
      doesn't chunk, so every S3 object can redirect.

[^uploads]: The client uploads to `<bucket>/nar/.tmp-<uuid>`. Odu streams the
    object back, verifies NarHash, size and `CA:`, then server-side copies it
    into place and writes the signed narinfo, so a path is visible only once
    verified. The readback costs one store → odu transfer on the downlink.
    - Measure first whether R2 honours `If-None-Match` on a copy; that decides
      cross-daemon put-if-absent for large objects.
    - Disk keeps chunked upload, and the 2.3 action gets the new path for free.
    - The trust rule is decided: odu reads the object back and verifies it.
      It never signs hashes the client claims.
    - Precedent: Cachix's client opens a multipart upload, PUTs each part to
      a presigned URL concurrently, then completes it. The server trusts the
      client's hashes (`cachix/src/Cachix/Client/Push/S3.hs`).

[^teams]: Membership is synced server-side from the App's installation token, so
    a removal in GitHub is a removal in odu. Private buckets are read through
    netrc. Runs and buckets gain an org field. The bucket page already exists
    (1.3), so 3.1 adds the org's facts to it.

[^hook]: `odu cache hook` appends `OUT_PATHS` to a crash-safe queue and returns.
    `odu cache hookd` drains it with batching, missing-path queries and
    retries. `services.odu.lane` installs both with the host's own write token,
    and non-NixOS hosts get documentation.

[^runpush]: `LaunchRequest` gains `push`. The service mints a write-only,
    single-bucket token for the run. The runner pushes each recipe's `result*`
    closure, and the catalog records it. `[metadata("odu:pin")]` pins a
    recipe's closure.

[^repos]: `run.start` accepts a repository plus a SHA as well as an absolute
    checkout. The in-house VM pool is one org's inventory, and `hosts.json`
    stays the source for loopback mode.

[^webhooks]: Push, pull_request and check re-run each start a run on the managed
    clone. Checks are posted through an installation token bound to the
    statuses send seam, and `odu protect` moves to that token.

[^f1]: kolu `packages/surface-app/src/serve.ts`: an HTTP `middleware` seam,
    `tls`, the `upgradeHeaders` allowlist, and `services(connection)` for a
    per-websocket layer. kolu-server uses that last seam for `CurrentViewer`.

[^bun]: Exit criterion: flat RSS over concurrent multi-gigabyte reads and pushes.
    #143's contract suite holds a 300 MB slow-reader S3 read under 64 MiB. The
    escape hatch is nginx `X-Accel-Redirect`, or a sidecar for NAR bytes.
