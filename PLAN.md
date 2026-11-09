# Odu as a product: Nix cache + CI you run yourself

Status: living, 2026-11-03.
- Phase 1 and all of Phase 2 are on master: 2.8 is #148, #150 and #152, and
  2.9 is #154.
- **Next is Phase 3**, orgs.
- **6.2 landed early, out of order** (#156): metrics needed no org model, and a
  deployment that is already public wanted numbers before it wanted tenancy.
  Nothing in Phase 3–6.1 depends on it.
- One step is one PR, and the order is a dependency order. There is no schedule.

## Contents

1. [Positioning](#positioning)
2. [Decisions](#decisions)
3. [Architecture](#architecture)
4. [Roadmap](#roadmap)
   - [Phase 1: foundations](#phase-1-foundations) ✅
   - [Phase 2: the cache as a product](#phase-2-the-cache-as-a-product) (2.1–2.4 ✅)
   - [Phase 3: teams](#phase-3-teams)
   - [Phase 4: CI pushes for you](#phase-4-ci-pushes-for-you) (4.1, 4.2, 4.4 ✅)
   - [Phase 5: hosted CI](#phase-5-hosted-ci)
   - [Phase 6: scale and hosting](#phase-6-scale-and-hosting) (6.2 ✅)
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
- **Pushes come from the RUN**, to the cache the repository already reads from
  (4.1). Explicit push stays for a machine with no run behind it; the host
  hook is deferred (4.3).
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
- **`kolu` moved to R2 by pushing afresh**, not by copying: the bucket is
  `kolu-r2` on the R2 bucket `kolu`, read at `https://cache.kolu.dev/kolu-r2`
  by odu, kolu, olai and agent-distro. The old `kolu` bucket (24 GiB on the
  PVC) and `r2test` are still there: `bucket_delete` has landed, and the
  operator deletes the two of them once it is deployed.
- **Pushes go to odu over Tailscale Funnel**, not through the tunnel:
  `https://odu-k3s.rooster-blues.ts.net` is public, the board behind GitHub
  sign-in, so no second hostname and no 100 MB body cap stand in a push's way.
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
  1. the run pushes, to the cache the repo already reads from (Phase 4.1);
  2. `odu cache push` or the GitHub Action, from anywhere (landed);
  3. the host hook, for everything a lane builds (Phase 4.3).
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
| 2.5 | Staging never refuses a valid NAR | ✅ #147 |
| 2.6 | The board, redesigned | ✅ #146 |
| 2.7 | GC and pins on every store | ✅ #145 |
| 2.8 | Reads leave odu | ✅ #148 |
| 2.9 | Uploads go straight to the store | ✅ #154 |
| 2.10 | The admin CLI is retired | ✅ #144 |

What each step delivers:
- **2.1 ✅** `cache.kolu.dev` is live through a Cloudflare tunnel, with no open
  port, and odu's CI pushes to it.
- **2.2 ✅** The pushed NAR is kept and served as is, with ranges. `CA:` is
  proved, and memory per NAR is constant.
- **2.3 ✅** One workflow step pushes a closure and goes red if a path doesn't
  answer.[^action]
- **2.4 ✅** A bucket lives on local disk or any S3 store (R2, AWS, Garage),
  and one contract suite proves both.[^objects] It's measured on the pod.[^bench]
- **2.5 ✅** The pusher's `nix store dump-path | zstd` stream read its FIFO
  non-blocking and took `EAGAIN` — "a writer is here, nothing yet" — for end
  of file. A NAR small enough that zstd's only write and the pipeline's exit
  land together was published as ZERO bytes, and the narinfo was then refused
  with `zstd exited 1`.[^zstd] Both reported symptoms were that one cause, and
  the disk/S3 split was a red herring: R2's first push refused the same paths.
- **2.6 ✅ The board, redesigned.** One PR that ships the "Night shift" design
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
  - **Two parity gaps 2.10's audit found, and handed here:** no face renders
    `pipeline.mermaid`, though `pipeline_read` carries it; and the board has
    no "newest run of THIS checkout" selector, which `odu ci status` resolves
    with git.
- **2.7 ✅ GC and pins on every store.** Liveness comes from pushes, not reads,
  because reads are about to leave odu. GC is written only against
  `ObjectStore`, and deletions purge the CDN.[^gc] The bucket page dry-runs the
  next collection.
  - **Pins from CI:** the push action's `pin:` is a boolean, and the workflow
    decides when (`pin: ${{ github.ref_name == github.event.repository.default_branch }}`).
    The name is derived, `<owner>/<repo>@<ref>/<system>`, one pin per system.
    odu, kolu and agent-distro hold theirs; olai's follow #684.
  - **Every bucket advertises `Priority: 41`**, so cache.nixos.org (40) wins
    for any path both hold, whatever the user's substituter order.
  - **The GC proof:** `gc_plan` takes a dry-run-only `retentionDays` (cache
    4.4), so `administration.feature` can prove the thing a collection must
    never be asked to prove — a bucket at 90-day retention with two pushed
    paths, the first pinned, a plan at `retentionDays: 0` naming only the
    unpinned one, and the `gc_run` that follows evicting nothing. The
    override is the plan's alone and writes nothing; `gc_run` has no such
    field.
- **2.8 ✅ Reads leave odu.** Every byte used to cross the odu machine's
  uplink, which caps reads on the pod at ~2.5 MiB/s.[^bench] The store now
  holds the whole protocol — `<bucket>/nar/<file>`, `<bucket>/<hash>.narinfo`
  and `<bucket>/nix-cache-info`, each with its own `Cache-Control` — written
  at push and backfilled at boot for caches that predate it.
  - **Option A:** one R2 bucket (a store) serves many odu buckets under one
    domain, keys in path form (`<publicUrl>/<bucket>/…`). A store declares
    that domain as `publicUrl`; a PUBLIC bucket on it is advertised there and
    reads never reach odu, which may be down.
  - **The operator binds the custom domain** (`cf r2 buckets domains custom
    create <r2-bucket> --domain <host> --zone-id <zone>`). The cloudflare row
    is untouched — it has no R2 API. Odu checks the binding at boot and logs
    `cache.store.public.unreachable` rather than refusing to start.
  - **A NAR on any S3 store, public or private:** 307 to a presigned URL that
    expires in ten minutes. A private bucket works because odu authorises
    first and the client re-sends its own `Range` to the store. Local disk is
    unchanged: odu streams it.
  - `bucket.migrate` moves a bucket between stores — an API verb and a board
    control, not a CLI command (2.10) — serving from the old store until the
    copy is done. `kolu` did not use it: a fresh bucket and a fresh push were
    cheaper than moving 24 GiB over the home uplink.
  - **Proof:** the e2e substitutes through a 307 from a private bucket with a
    real Nix client, and the NixOS VM test copies through one.[^reads]
  - **The cache names its own push address (#150).** A read address is no
    longer a push address, so `nix-cache-info` states both in two lines Nix
    ignores — `Odu-Origin` (this daemon) and `Odu-Bucket` — on odu's routes
    and in the object in the store, rewritten by content when the origin
    moves. `odu cache push --cache <substituter>` reads them (sending the
    bucket token, so a private bucket answers), the push action takes one
    `cache:` input where it took `origin:` and `bucket:`, and kolu's
    `publish-closure` declaration is `pusher = { kind = "odu"; }` — a consumer
    repository holds the one fact its `nix.conf` already has.
  - **#152:** Cloudflare gzips `text/plain` between R2 and the pod, so the
    store's HEAD could not match `nix-cache-info`'s recorded size and the
    backfill refused to rewrite it. An object's size is its metadata's;
    `content-length` is checked only on an answer that was not re-encoded.
- **2.9 ✅ Uploads go straight to the store.** `odu cache push` asks the
  bucket where a NAR's bytes go and is answered from the bucket's STORE: an
  S3-backed bucket hands back presigned URLs, and the client PUTs the NAR to
  the store itself. Odu then streams the object back, verifies it, copies it
  into place and records the path. That is Cachix's upload, but without
  Cachix's trust in the client's hashes.[^uploads]
  - **Measured on R2** (bucket `kolu`, 2026-11-03): `If-None-Match: *` is
    IGNORED on the single-request `CopyObject` — 200, and the destination is
    overwritten — but HONOURED on `CompleteMultipartUpload`, which answers
    `412 PreconditionFailed`. Odu's `copy` is a multipart copy
    (`UploadPartCopy` + a conditional completion), so first-kept-wins holds
    ACROSS daemons, not just within one. This also corrects what [^objects]
    said while it was undocumented.
  - **Benchmark, same pod and the same home uplink** (`kolu-r2`, defaults —
    concurrency 4, 64 MiB parts). The closures differ because the first push
    put its paths in the bucket, so the second used a reserved twin:

    | | staged (master, `c4d3772`) | direct (this branch) |
    | --- | --- | --- |
    | wall | 45.7 s | **37.4 s** |
    | paths | 5 | 2 |
    | NAR bytes | 225.3 MiB | 204.2 MiB |
    | wire bytes (zstd) | 105.2 MiB | 99.2 MiB |
    | wire throughput | 2.30 MiB/s | **2.65 MiB/s** |

    Per wire byte that is **13.2 % faster** (the staged run scaled to the
    direct run's bytes is 43.1 s against 37.4 s). One run each, so read the
    rate rather than the seconds. The number the table cannot show is the
    point: the daemon moved 99 MiB of NAR in the first row and none in the
    second — what it spends now is a readback on its own downlink, which the
    client never waits on beyond the narinfo.
- **2.10 ✅ The admin CLI is retired.** The board and the API are the product,
  so the CLI keeps only what needs a shell on the machine that holds the paths
  or the checkout: `odu ci …`, `odu cache use|login|push`, `odu auth login`,
  and the service itself (`web`, `surface`, `mcp`). Every administrative verb
  is a control on the board and a verb on the API; the bespoke commands went
  one PR at a time through 2.4–2.9, and `odu surface <row> <verb>` is the full
  API by derivation.[^retire]

### Phase 3: teams

- **3.1 Orgs.** Teams self-serve without the operator:
  - membership synced from GitHub, roles, many buckets per org;
  - private buckets;
  - quotas, token revocation and an audit log.[^teams]

### Phase 4: CI pushes for you

- **4.1 ✅ The run pushes** (#159, #162). A repo that reads from an odu cache
  builds for it: the `extra-substituters` line already in `flake.nix`
  `nixConfig` is the only declaration, and `odu ci run` pushes every recipe's
  `result*` closure there after the recipe exits 0. Nothing in any recipe, no
  token in the repo, no second place to name the bucket. The push is its own
  step on the run page with its own log stream. Dogfooded on kolu
  (juspay/kolu#2345): the lanes warm `kolu-r2` and the linux GitHub push job
  is gone.[^runpush]
- **4.2 ✅ Provenance and pins** (#169). Every narinfo a run writes carries the
  run's id and the commit it was built from (cache 4.7), and the bucket page's
  Paths table draws the commit short and the run as a link to its own page.
  `[metadata("odu:pin=<ref>")]` on a recipe keeps its closure out of GC under
  `<owner>/<repo>@<ref>/<system>` — the same name the Action derives, so a run
  and a workflow re-point one pin rather than two — on a run that is actually
  on that ref; another ref pushes silently, and a run on no ref says one line
  on its push log why. The ref is the one `gitBranch` the coordinator already
  read for the manifest, so a board and a pin cannot disagree.[^pins]
- **4.3 The hook.** For hosts whose every build should land in one org bucket:
  the host owner installs it, lanes still hold no repo credentials, and a cache
  outage only queues paths. Deferred until a lane's own store stops being
  enough.[^hook]
- **4.4 ✅ The pod runs CI** (#161 + nixos-config). The "Ours" shape for real:
  the service that serves the cache is the one that runs the lanes. The pod's
  inventory names `ci@croissant`, `ci@naiveintent` and `ci@petit`, reached
  through Tailscale-operator egress Services; one pod ssh identity is
  authorised on every lane's `ci` user; lanes trust the pod's substituter. A
  personal token was enough to act from a shell — what shipped is `odu ci run
  --checkout <abs> --sha <sha>` and `actor` on every run. Still manual until
  5.1: the checkout under `/data/checkouts/<repo>`, and the tailnet policy
  (lanes ← `tag:k8s` on 22, pod ← lanes on 443).[^podci]

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
- **6.2 ✅ Metrics.** `GET /metrics`, Prometheus text, on the host — authorised
  by the root token or a `metrics` token (`metrics_token_mint`/`_list`/`_revoke`),
  never anonymous. Rows contribute through a cordis registry, so the host opens
  no row's database: the cache row counts requests, bytes, uploads and
  collections and reads paths, bytes, pins and lifetime hits from SQL; the runs
  contribute `odu_runs_total`, `odu_run_duration_seconds`,
  `odu_node_duration_seconds` and lane use from the on-disk catalog and the last
  venue probe. Counters are process-local and reset on restart.
- **6.3 Metering.** Per-org storage, transfer and build minutes, with limits
  and an export for billing.

## Risks

| Risk | Mitigation |
| --- | --- |
| Credentialed `nix copy` varies by Nix version | `odu cache push` is the supported path; Basic auth for Lix and newer Nix |
| The first database in the tree | A small repository layer, so Postgres (6.1) is a swap |
| Server mode touches every verb | Loopback mode's unchanged tests are the regression guard |
| One box serving many developers | Reads leave odu in 2.8 |
| Run-scoped push relaxes "lanes hold no credentials" | Scoped, write-only, run-lifetime tokens, revoked when nothing serves the run |
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
| F5 | `post-build-hook` is a Nix daemon setting; lane provisioning never edits `nix.conf` | The hook is host configuration (4.3); 4.1 needs no daemon setting |
| F6 | Lane hosts never see credentials; GitHub posting happens on the coordinator | 4.1 relaxes this, bounded to one run and one bucket |
| F7 | A run needs an absolute checkout on the service's machine | Hosted CI needs managed clones (5.1) |
| F8 | Hosts are per user (`hosts.json`) | Org-scoped venues (5.1) |
| F9 | The flake exports odu, the runner, the web UI and `services.odu`; its `nixConfig` names `https://cache.kolu.dev/kolu-r2` | Odu is its own cache's first consumer |
| F10 | Every client takes `--origin`; remote dialling exists | Remote clients need only authentication |
| F11 | odu's CI builds on Linux and macOS and pushes with the 2.3 action | The cache is dogfooded on every push to master |
| F12 | Our deployment is a pod with no nginx, public through Tailscale Funnel behind GitHub sign-in; bucket reads come from R2[^pod] | Identity had to come before a public cache |
| F13 | Rows sit behind one fence: only roots name rows (`fence.test.ts`) | Identity is the host's fact plus the `auth` row |

## Appendix: old PR names

Commits and PR bodies use the earlier names.

| Old | New | | Old | New |
| --- | --- | --- | --- | --- |
| PR 0 | 1.1 | | PR 3c2 | 2.7 |
| PR 1 | 1.2 | | PR 3d | 2.8 |
| PR 1.5 | 1.3 | | PR 3g | 2.9 |
| PR 2 (+hotfix) | 1.4 | | PR 4 | 3.1 |
| PR 2.5 | 1.5 | | #159, #162 | 4.1 ✅ (4.3 deferred) |
| PR 3e | 1.6 | | #169 | 4.2 ✅ |
| PR 3a | 2.1 | | #161 + nixos-config | 4.4 ✅ |
| PR 3b (+fix) | 2.2 | | PR 7, 8 | 5.1, 5.2 |
| PR 3f | 2.3 | | PR 9, 10 | 5.3, 5.4 |
| PR 3c | 2.4 | | PR 11 | folded into 2.4–2.9 |
| | | | PR 12 | 6.1 |
| | | | PR 13, 14 | 6.2, 6.3 |

[^chutney]: chutney's Attic: 669 GB on S3 and 46 GB of Postgres, growing
    without bound with GC off. Its chunking cost more than it saved on S3.

[^identity]: Sign-in uses the App's authorisation-code flow (1.4). Installation
    tokens arrive in 3.1 (membership sync) and 5.2 (checks). Expiring user
    tokens are refused until 3.1 stores refresh tokens.

[^pod]: nixos-config `k8s/apps/odu` runs `odu web` in `pureintent`'s K3s: one
    replica, with a `local-path` PVC for the catalog and the `local` store. It
    publishes `https://odu-k3s.rooster-blues.ts.net` over Tailscale Funnel
    (public; GitHub sign-in fronts the board; CI pushes there). The `r2` store
    is the R2 bucket `kolu` with `publicUrl = https://cache.kolu.dev`, a custom
    domain the operator bound with `cf`; the cloudflare row's tunnel carries
    nothing today. The root token, the GitHub App and the R2 keys (Account
    token `odu-r2-kolu`) come from 1Password through External Secrets.
    `ODU_CACHE_STORE` remains only so 2.2's migration can dump the old 166 GB
    store; it is deleted after `cache.migration.complete`. Buckets: `kolu-r2`
    (production, on `r2`, skips `cache.nixos.org-1`), the old `kolu` (local,
    no longer advertised) and `r2test` (its objects in the retired R2 bucket
    `odu-test`); `bucket_delete` exists now, and the last two go when the
    operator runs it after the deploy.

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
    client on the rows it declares. **A row is a set of packages, not a
    directory:** the fence reads each manifest's `cordis.row`, so `ci` is
    `@odu/ci` (the plugin the daemon mounts, and the board's view) plus
    `@odu/cli` (`odu ci`'s argv grammar and its TUI). The split is the
    renderer: `@opentui/core` and `@xterm/headless` are a cost the package
    served inside the daemon must not carry.

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
    buffers. R2 honours `If-None-Match` on `PutObject` (412, measured) and, as
    of 2.9's probe, on `CompleteMultipartUpload` too (412, measured — it is
    still undocumented), so an object is put-if-absent across daemons at any
    size. It is IGNORED on the one-request `CopyObject`, which is why odu's
    `copy` is a multipart copy.

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

[^zstd]: `narinfo upload answered 400: nar/<hash>.nar.zst: zstd exited 1`,
    seen under concurrent pushes, for `exec-path.c` (952 B compressed) and for
    `kolu-typecheck-2.2.0`, whose NAR is an empty file (95 B). The cause was
    the pusher's FIFO read taking `EAGAIN` for EOF and publishing a NAR of
    zero bytes; measured at 12–24 empty dumps in 640. Fixed in #147.

[^reads]: How 2.8 works:
    - At push, odu writes `<hash>.narinfo` and `nar/<file>` as objects with
      `Cache-Control` (NARs immutable for a year, narinfos and
      `nix-cache-info` a day). A boot backfill writes the ones a cache from
      before this never had, and GC deletes a row's narinfo object with the
      row and purges it. There is no key-rotation verb to rewrite them for.
    - A PUBLIC bucket's substituter URL is its store's `publicUrl` when the
      store declares one; the OPERATOR binds that domain to the R2 bucket
      (`cf r2 buckets domains custom create`). The cloudflare row is
      untouched — it has no R2 API, and the tunnel is still what a bucket's
      own domain rides.
    - Private-bucket redirects rely on Nix following them
      (`CURLOPT_FOLLOWLOCATION`) and on curl dropping `Authorization` when the
      host changes. The e2e proves both, with odu on `127.0.0.1` and the
      gateway on `localhost` so the hosts differ as strings.
    - What odu gives up: `cache.nar.served` logs `source: "redirect"` and
      `bytes: 0`, not bytes.
    - Precedent: Attic answers `307` to a 10-minute presigned URL for
      single-chunk NARs only, and stitches multi-chunk ones through the server
      (`server/src/api/binary_cache.rs`). Cachix serves NARs from a CDN. Odu
      doesn't chunk, so every S3 object can redirect.

[^uploads]: How 2.9 works. The client asks `POST …/nar/<file>/upload` first;
    the answer is the bucket's STORE's, not a flag: `{mode:"direct", upload,
    partSize, part}` for an S3 store, `{mode:"staged"}` for disk, and the row
    carries the same fact as `writesTo` (cache surface 4.2). The client sends
    the NAR to `<bucket>/nar/.tmp-<uuid>` as the PARTS of one multipart
    upload — part 0 at the URL the plan carried, the rest one presigned part
    at a time, each ETag kept — and `POST …/upload/<id>/complete` joins them
    and confirms the object. The
    narinfo PUT is where it is decided: odu streams the temp object back,
    verifies NarHash, size and `CA:` WITHOUT spooling it to disk, copies it
    into `nar/<file>` with `If-None-Match: *`, deletes the temp and records
    the row under the write lock. 200 is stored, 400 names the reason, and the
    temp is deleted either way. The readback costs one store → odu transfer on
    the downlink.
    - **R2, measured 2026-11-03** — bucket `kolu`, not the `odu-test` this
      step's brief named: the credentials that could be produced for the probe
      were scoped to `kolu` (`odu-test` answered `403 AccessDenied`), so the
      probe ran under a `_probe-29/` prefix there and removed everything it
      made. `If-None-Match: *` is IGNORED on the single-request `CopyObject`
      (200, destination overwritten; Cloudflare's own destination-side
      condition is `cf-copy-destination-if-none-match`, which does answer 412)
      but HONOURED on `CompleteMultipartUpload` (412 `PreconditionFailed`).
      Odu's `copy` is `UploadPartCopy` + a conditional completion, so
      put-if-absent holds across daemons for a copy of any size. R2 also
      completes a multipart upload whose only part is well under 5 MiB.
    - **THE PROOF IS BINDING BECAUSE THE KEY HAS NO WRITER.** Odu presigns
      nothing for the temp key but PARTS of one multipart upload (part 0
      rides on the plan, so a one-part NAR costs no extra round trip), and
      completing that upload ends them — so from the completion onwards
      nothing a client holds can change the object odu then reads, proves and
      copies. It asks for no conditional feature, so it holds on every S3
      service. A presigned plain `PUT` would have been one request fewer and
      a key writable for ten minutes; it was removed from `ObjectStore` for
      that reason.
      - The readback's ETag still rides into the copy as
        `x-amz-copy-source-if-match`, and a windowed read carries `If-Match`
        on the first window's ETag; a source that moved is `source_changed`,
        a 400 and nothing kept. That is a SECOND line only: **R2 lists
        `x-amz-copy-source-if-match` as not implemented on `UploadPartCopy`**
        (it implements it on `CopyObject`, which odu does not use), so the
        guarantee could not rest there. It fails closed — a read that names
        no version refuses the push.
      - NOT RE-MEASURED ON R2, and it needs no new measurement: it uses the
        two calls already measured there (a part `PUT`, and a conditional
        `CompleteMultipartUpload`). The short-lived `kolu` credentials were
        deleted with the probe's scratch directory, so a fresh probe wants
        fresh keys; what it would add is confirmation that a part URL stops
        writing after its upload completes, which is S3's own semantics and
        not a conditional feature.
    - A part is 5 MiB at least (S3's floor), the store's own part size, or the
      client's `--part-size` — the largest of the three. In direct mode that
      flag is a FLOOR; staged, it stays the ceiling a proxy imposes.
    - An expired presign or a 4xx at the store re-BEGINS the path: a new
      upload id, rather than a refresh of a URL for an upload whose state the
      client cannot see. An upload record is the daemon's, in memory, and is
      swept after an hour with its temp object and its multipart upload.
    - Disk keeps chunked upload, and the 2.3 action gets the new path for free.
    - An origin that cannot negotiate (404) is refused by name — no silent
      fallback to staged, which on an S3 bucket would go on pushing every byte
      through the daemon.
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
    and non-NixOS hosts get documentation. The daemon runs the hook, so it
    cannot know which repo asked: one bucket per host, chosen by the host.

[^runpush]: Target resolution at `run.start`, on the service. `nix eval` of
    the checkout's `nixConfig` — a plain attrset, no inputs fetched — then
    **the URL rule: a substituter is a target when it is one this daemon
    ADVERTISES for a bucket it serves** (the path form under its public
    origin, a bucket's own domain, or a public bucket's store URL), confirmed
    against what the cache row publishes. Nothing in a `nix-cache-info` body
    decides anything: the probe shape let a flake naming an attacker's host
    claim to be any bucket here, collect a write token for it, and have that
    token posted to the attacker's server. The URL rule also resolves a
    PRIVATE bucket, which an anonymous probe never could. The evaluation runs
    under `restrict-eval`, with `allow-import-from-derivation false`, in an
    explicit minimal environment and on a process-group deadline, because
    `flake.nix` is the least trusted input odu has. None means no push; two is
    refused with both URLs, because a repo builds for one cache — no override
    key until someone hits this. The published key must appear in
    `trusted-public-keys`, else a warning. **The interim bound, until orgs
    land in 3.1, is the OPERATOR's:** any checkout this daemon runs may push
    to any bucket it serves, because no row yet says which repository owns
    which bucket — which is why `run.start` only reaches here for a checkout
    the operator already handed it. `LaunchRequest` gains `push`; the service
    mints a write-only, single-bucket token that expires with the run and
    carries the RESOLVED origin and bucket to the lane, so the runner dials
    nothing it was not told to; it pushes each recipe's `result*` closure —
    globbed where the recipe actually ran — through 2.9's direct upload, and a
    push that fails reddens its node. The token is minted by the cache row for
    the ci row through a `@odu/cordis` broker (no principal, no root token),
    kept out of the recipe's own environment, and revoked when the projection
    sees nothing serving the run any more — not at first settle, which would
    meet a `--linger` rerun with a dead credential. The GitHub Action gains the
    same inference, so its `cache:` input becomes optional — made real in #168
    via `odu cache target` (#163), because the inference alone withheld the
    token (SEC-5) and the push 401'd: the Action resolves the URL and then
    NAMES it, which a workflow may do where a laptop may not.

[^pins]: Not a catalog: the CACHE's own object row learns two nullable
    columns, written at the narinfo PUT from `x-odu-run` and `x-odu-commit`
    headers — above the narinfo body, which is a format every Nix client
    parses. They COALESCE on conflict and independently, so a developer's bare
    re-push erases neither and the Action (which states `--commit` only) does
    not blank a run. `cache_bucket_paths` answers both; a group answers its
    newest version's, out of the same subquery row its hash comes from. The
    pin goes through the run's own write token (`createdBy: write` already
    re-points a write token's pin), only when every path of that recipe
    landed, and only on the ref the recipe named.

[^podci]: Two repositories. nixos-config: `ODU_HOSTS` on the Deployment names
    the lanes; one Tailscale-operator egress Service per lane
    (`tailscale.com/tailnet-fqdn`) with ssh-config aliases, so the daemon keeps
    binding only the pod (`hostNetwork` was the rejected alternative); the
    pod's ed25519 identity as a Secret from 1Password, its public key in each
    lane's `users.users.ci.openssh.authorizedKeys.keys` through a shared
    `odu-lane` module; `known_hosts` pinned by keyscan;
    `nix.settings.trusted-users = [ "ci" ]` on every lane, else Nix ignores the
    substituter and keys the coordinator hands it; the workspace root
    `/tmp/odu` must be writable by the `ci` user (#164). The lane must not be
    the pod's own node: its builds filled the disk and the kubelet evicted the
    pod mid-run. Two tailnet policy rules outside any repo: `tag:k8s` →
    lanes on tcp:22, lanes → `tag:k8s` on tcp:443. The checkout under
    `/data/checkouts/<repo>` until 5.1 manages clones. odu: a
    PERSONAL token already drives every run verb — the CLI sends `$ODU_TOKEN`
    as `Authorization: Bearer` on the websocket upgrade and the auth row
    resolves it to a signed-in principal — so no operator-token kind was
    needed, and the earlier plan for a `metrics`-style one is withdrawn. What
    was missing was the CHECKOUT: `odu ci run` computed the laptop's toplevel
    and HEAD, so a shell could not name a path on the pod. `--checkout <abs>`
    with a required `--sha` sends both verbatim (refused unless a service is
    named — `--origin`/`ODU_WEB_ORIGIN` — since the default is the daemon for
    where you stand), and a run now records `actor` — the principal's login,
    or `@local` — so "who started this" is answerable after the fact. The
    host-side list above stays until 5.1 moves the inventory into org venues.

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
