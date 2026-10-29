# Odu as a product: Nix cache + CI you run yourself

Status: draft, 2026-10-28. Decisions below were taken in conversation. There is
no schedule: one phase is one PR, and the split is grounded in the source facts
listed in "What the code is today".

## Positioning

Today odu is "live CI for `just` pipelines": a per-user loopback service, a web
board, CLI/MCP faces, SSH lane hosts, GitHub commit statuses.

The product: **the Nix binary cache and CI that teams run on their own
hardware, and that we can host for them.** Three pillars, one service, one board:

1. **Cache.** Per-team buckets with revocable tokens, server-side signing,
   bounded storage (GC with pins and reference tracking). Plain Nix HTTP
   binary cache protocol, so every Nix client works unchanged.
2. **CI.** The existing `just` DAG runner, triggered by GitHub (later
   Bitbucket/Jenkins) webhooks, running on the team's lanes or our VMs, and
   **pushing every built path to the team's bucket automatically** through a
   post-build-hook. No `cachix push` step in any workflow.
3. **One board.** Runs and cache in the same UI: which run produced a path,
   hit rates per repo, storage per team, agent access over MCP.

AGPL, self-hostable as one NixOS module on one machine (small teams) or as a
cache node with object storage plus a lane pool (large teams). Hosted later at
a monthly price.

### Why this wins

| Against | They are | We are |
| --- | --- | --- |
| cachix | Closed protocol, "contact sales" pricing, push step in every workflow, cannot self-host without enterprise sales | AGPL, self-hosted or hosted, CI pushes for you, own macOS builders |
| Attic / celler | Unrevocable JWTs, no pinning (chutney: 669 GB S3 and 46 GB Postgres, growth unbounded, GC off), no UI, no login, no listing | Revocable tokens, GC that cannot delete a live closure, GitHub login, team UI, built-in hook queue |
| niks3 | Single cache, S3 only, no CI | Multi-tenant, local disk or S3, CI included |
| FlakeHub Cache | Not self-hostable, GitHub Actions only | Self-hostable, any CI, your own hardware |
| garnix / Hercules | Hosted-only or hosted coordinator | Fully on-prem possible |

## Decisions taken

- **Cache engine:** own data plane inside odu, TypeScript/Bun in the monorepo.
  Not wrapping Attic, celler or niks3.
- **Push model:** post-build-hook on lane hosts (primary); explicit push as a
  fallback.
- **Identity:** GitHub login plus admin-issued tokens for the OSS stage;
  generic OIDC (Google Workspace) for internal teams later.
- **CI trigger:** GitHub App webhooks, pipelines remain the CI-tagged
  justfile. Bitbucket/Jenkins as later webhook adapters.
- **v1 hosting:** `services.odu` NixOS module, single process, local disk,
  on the dedicated server. S3 and runner pools later.
- **First users:** OSS projects (single public bucket), then internal teams.
  Migration tooling from Attic is out of scope.

## What the code is today (facts the PRs are built on)

Each item names where it is checked.

- **F1. HTTP server.** `odu web` serves through kolu's `serveSurfaceApp`
  (`packages/cli/src/web.ts`). App routes are one Effect `HttpRouter` layer
  merged beside the shell (`routes: Layer.merge(mcpRoute, mcpGetRoute)`),
  and the framework exposes an HTTP `middleware` seam, a `tls` option, an
  `upgradeHeaders` allowlist, and a `services(connection)` seam that provides
  a per-websocket Effect layer to that connection's handlers (kolu master,
  `packages/surface-app/src/serve.ts`). kolu-server already uses exactly this
  to provide a per-connection `CurrentViewer` service from `x-forwarded-for`
  (`packages/server/src/index.ts`, `router.ts`). Nothing in kolu does cookies,
  OAuth or Bearer tokens. Cache routes are one more layer; a principal is one
  more per-connection service, in odu.
- **F2. No authentication anywhere.** The service is a per-user singleton:
  gate and home under `~/.local/state/odu-web/` (mode 0700), one fixed origin,
  an Origin allowlist for the websocket and `/mcp`, nothing else. Anyone who
  reaches the listener controls CI (`web.ts`, docs "Access through Tailscale").
- **F3. No database.** The run catalog is per-user append-only files under
  `~/.local/state/odu` (`packages/run-history/src/paths.ts`, `store.ts`).
  Nothing in the tree uses SQLite or Postgres.
- **F4. The authority wall.** Every public command is a client of the service;
  `packages/cli/src/authority.test.ts` derives the policed set from `src/main.ts`
  and forbids importing the coordinator, catalog writes, or the checkout dial.
  A cache push client talks HTTP to a cache server with a token and imports
  none of those, so it is admissible; a push cannot go *through* the service
  anyway, because the paths live on the builder.
- **F5. Lanes.** A lane is an SSH session via kolu `surface-remote`; the host
  pulls the `odu-runner` closure resolved from odu's baked agent source
  (`packages/execution/src/coordinator/runnerFlake.ts`, `lane.ts`). Nothing in
  provisioning edits the host's `nix.conf`, and `post-build-hook` is a daemon
  setting. So the hook is **host configuration**, installed by the host's
  owner (NixOS module or by hand), never by a run.
- **F6. Lane hosts never see credentials.** GitHub posting happens on the
  coordinator by spawning `gh api` with the user's credential
  (`coordinator/statuses.ts`), through an injectable send seam. A GitHub App
  installation-token sender is one binding of that seam. `odu protect` uses
  the same `gh`.
- **F7. A run needs a checkout on the service's machine.** `run.start` refuses
  a non-absolute path (`packages/service/src/start.ts`) and the coordinator pins
  HEAD with `git worktree`; remote lanes fetch from origin plus a bundle. There
  is no "repository" concept and no server-managed clone, so a webhook has
  nothing to start a run in today.
- **F8. Hosts are per user.** `~/.config/odu/hosts.json` or `$ODU_HOSTS`,
  SSH `ci@host`, leases held by the service's child. No org scoping.
- **F9. Packaging.** The flake exports `odu`, `odu-runner`, `web-ui`; there is
  no NixOS module. Its `nixConfig` trusts `cache.nixos.asia/oss`, and macOS
  lanes need that cache trusted to pull the runner (docs "Choose hosts"), so
  odu's own flake is the first consumer of the new bucket.
- **F10. Remote dialling exists, unauthenticated.** Every client takes
  `--origin URL`; a named origin is dialled and never auto-started.
- **F11. How odu warms its own cache today.** `.github/workflows/nix-cache.yml`
  builds `.#odu .#odu-runner .#web-ui` on ubuntu and macos runners and pushes
  the closures with `attic push` to `cache.nixos.asia/oss` using an
  `ATTIC_TOKEN` secret; a second job runs kolu's `publish-closure` action,
  which rewrites the runner content-addressed, pushes it with the same attic
  token, and writes the `ca-index` branch a lane dial reads. The flake's
  `nixConfig`, the workflow's `nix_conf`, and the docs all name that cache.

Consequences for the split:

- The web board cannot go on the public internet before authentication
  exists (F2). So PR 2 exposes **only the cache protocol** publicly and
  keeps the board on loopback; identity and the public board are one PR
  (PR 3), not an afterthought as the earlier draft had it.
- "CI pushes for you" has two halves with different owners: the hook is host
  config (F5), and run-scoped push needs a token on the lane, which relaxes
  F6 and must be a scoped, short-lived, write-only token.
- Hosted CI needs server-managed clones (F7) and org-scoped hosts (F8) before
  a webhook can do anything. That is its own PR (PR 7), before the App.

## Architecture

### Protocol (per bucket, standard Nix)

```
GET  /<bucket>/nix-cache-info             StoreDir, WantMassQuery: 1, Priority: 40
HEAD /<bucket>/<hash>.narinfo
GET  /<bucket>/<hash>.narinfo
GET  /<bucket>/nar/<filehash>.nar.zst     stream, or 302 to presigned URL (PR 11)
PUT  /<bucket>/nar/<filehash>.nar.<ext>   Bearer or Basic; any ext Nix sends (xz by default, zst with ?compression=zstd)
PUT  /<bucket>/<hash>.narinfo             server re-signs with the bucket key; URL field kept as sent
POST /_odu/v1/buckets/<bucket>/missing    batch "which of these are you missing" (odu push client)
```

Public buckets read without a token. Writes, and reads of private buckets,
accept `Authorization: Bearer <token>` or HTTP Basic with any username and
the token as password. Nix speaks the second through curl on every request,
uploads included, so `nix copy --to` works with no odu code on the client.
`odu cache push` exists for the batched missing-paths query, retries and the
login flow, not because Nix cannot authenticate.

### Credentials on the client

- **`odu cache push`** resolves the token in this order: `--token-file
  <path>`, `$ODU_CACHE_TOKEN`, then the entry for the bucket's origin in
  `~/.config/odu/cache/credentials` (mode 0600, written by `odu cache login
  <origin>`, one entry per origin). The bucket argument is a name resolved
  against the logged-in origin, or a full `https://host/bucket` URL. CI sets
  the secret into `ODU_CACHE_TOKEN` and never logs in.
- **`nix copy --to`** and private reads use netrc. Nix reads only the file
  named by its `netrc-file` setting (default `/etc/nix/netrc`), never
  `~/.netrc`, so `odu cache use <bucket>` prints the `netrc-file` line and the
  `machine <host> password <token>` line together. For CI the token can ride
  in the URL instead: `nix copy --to "https://x:$ODU_CACHE_TOKEN@host/bucket"`.
- The token is never on the lane host in PR 1; that is PR 5's hook, with the
  host's own token under `services.odu.lane`.

### Signing

One ed25519 keypair per bucket, generated and held by the server. Narinfos are
signed on ingest; pushers never hold a key. Client signatures are kept. The
bucket's `extra-substituters` and `extra-trusted-public-keys` lines and a
`nixConfig` flake snippet are printed by `odu cache use <bucket>` (PR 1) and
shown on the bucket page (PR 4).

### Storage

- **Blobs:** the server's own Nix store. `put` imports a NAR through the
  daemon (`nix-store --import` semantics; the service user is a trusted user
  on the module's machine), `get` streams `nix store dump-path` through zstd,
  `delete` drops odu's gcroot and runs `nix-store --delete`. Dedup across
  buckets is by store path, for free. No second copy on a single machine,
  which is the small-team shape and the developer's laptop. On-the-fly
  compression costs CPU per cold read; nginx `proxy_cache` (PR 2) absorbs the
  repeats. S3-compatible storage is the second implementation in PR 11.
- **Metadata:** SQLite in WAL mode behind a narrow repository layer (first
  database in the tree, F3). Tables: `org`, `bucket`, `token`, `object`
  (bucket, store path, narinfo fields, references, nar hash and size,
  created, last-accessed), `pin`, `audit`.
- **On disk:** under odu's state directory (`$ODU_STATE_DIR`, else
  `$XDG_STATE_HOME/odu`, else the platform default `run-history/paths.ts`
  already resolves): `cache/cache.sqlite` and `cache/gcroots/`; the paths
  themselves are in `/nix/store`. Signing keys live in the database; the
  database is a secret, and backup is the database; paths are rebuilt or
  re-pushed.
- **GC:** per-bucket retention on last access; an object is evicted only when
  nothing retained in the bucket references it and it is not under a pin;
  a path with no retaining bucket loses its root and is deleted from the
  store. Pins are named and root a closure. This is the niks3 model and the
  direct answer to chutney issue 52.

### Tokens and identity

Opaque random tokens stored hashed, with scope (bucket glob, read/write/admin),
expiry, last-used, and single-token revocation. In PR 1 a root token (from
the module's secret file) mints them over the surface; from PR 3 GitHub
OAuth users mint and revoke in the UI or CLI. Roles: owner, admin, member.

### Where the cache lives in the process

A new workspace member `packages/cache` (protocol, blob store, metadata, GC,
signing, tokens) with its own closure test, importing nothing from
`execution`. Its routes are a layer merged in `web.ts` (F1). Its admin
operations (`cache_create`, `cache_token_mint`, `cache_token_revoke`,
`cache_pin`, `cache_gc`, `cache_stats`) are verbs on the shared surface, so
`odu cache …`, the browser and MCP all reach them through the service, which
is what the authority wall requires (F4). `odu cache push` is the one command
that is a client of a *different* authority: the cache's HTTP API, with a
token, from the machine that holds the paths.

### Push paths

1. **Hook (primary, PR 5).** `odu cache hook` is a Nix `post-build-hook`
   that appends `OUT_PATHS` to a crash-safe local queue and returns;
   `odu cache hookd` drains it with batching, missing-path queries and retries.
   The credential is the host's own, configured by its owner
   (`services.odu.lane.pushTo`), which keeps F6 intact.
2. **Explicit (PR 1).** `odu cache push <bucket> <paths…>` from any machine
   or any CI, including a documented GitHub Actions step. It streams
   `nix store dump-path` through zstd into the PUT, uploads several paths at
   a time, retries per path, and asks `missing` first. `missing` drops paths
   signed by an upstream key (`cache.nixos.org-1` by default, per bucket), so
   nixpkgs never lands in a bucket; this is attic's upstream filter and the
   main thing `nix copy` cannot do. `nix copy --to https://…/<bucket>` with
   netrc or a token in the URL stays for people who want nothing odu-specific
   (see "Credentials on the client"); it buffers each NAR in memory and
   probes paths one at a time. Known gaps against cachix and attic, kept
   deliberately: uploads go through the server until PR 11 adds presigned
   PUT; dedup is per store path, not per chunk; no watch mode until PR 5.
3. **Run-scoped (PR 6).** `odu run --push <bucket>`: the runner pushes each
   recipe's `result*` closures after the recipe, using a write-only token
   scoped to that bucket with a lifetime of the run. This is a deliberate,
   bounded relaxation of F6 and is documented as such.

### Server mode (PR 3)

Built on the seams F1 names, and decided: **the principal is odu's, and kolu
needs no change.** nginx terminates TLS and owns the public name. odu names
`cookie` in `upgradeHeaders`, resolves the session in `services(connection)`
and provides a `CurrentPrincipal` service, the exact shape of kolu-server's
`CurrentViewer`; verbs read it with `CurrentPrincipal.use`. The HTTP
`middleware` resolves `Authorization: Bearer` for `/mcp` and the cache admin
routes; the cache protocol routes check their own per-bucket token per
request. One design point the seam forces: the session is checked at upgrade
only, so logout and expiry must close that principal's open sockets, which
odu owns through its session table. If a second kolu app later needs a
cookie principal, the helper moves into `@kolu/surface-app`; not before.
Every surface verb receives a principal and an org; the per-user catalog (F3)
gains an org field on runs and buckets so one server-wide catalog can be
filtered. The developer's loopback mode stays as it is: no principal, same
verbs, same board.

### Deployment shapes

- **Small team, one NixOS machine:** `services.odu.enable`, local disk, the
  same box is cache, board and lane runner (localhost lane, hook configured by
  the same module).
- **Large team:** cache node(s) with S3 and Postgres; lane pool of the team's
  own machines or our in-house VMs; nginx `proxy_cache` and/or CDN in front of
  reads.
- **Hosted:** the large shape, multi-org, metered per org.

## Roadmap: one phase is one PR

There is no schedule. Each PR is substantial, merges green on both platforms
with evidence, and leaves master in a state someone can run and rely on. A
capability reaches the public surface only in the PR that completes it, and
nothing merges that a later PR has to finish. The order is a dependency order.

### PR 0: the caller and the forge (refactor, behaviour-preserving)

> **Docs:** No user-facing change. Every command, verb and flag behaves as
> before. One note in the changelog: `odu protect` now gives up on a hung
> `gh` after 30 seconds instead of waiting forever.

Two per-caller concerns are threaded by hand today, and three later PRs would
each re-thread them. This PR changes no behaviour; the existing unit, CLI
e2e and browser e2e suites are the proof.

What lands:
- **`Caller`.** `hostsFile` is carried as a loose field at 52 sites in 13
  files: five verb input schemas in `service-client/surface.ts`, the dispatch
  in `service/service.ts`, and every launch, venue and protect port in
  `service/ports.ts`, each annotated "the CALLER's `$ODU_HOSTS`". This PR
  gives it one home: a `Caller` value assembled per call from the connection
  and the input, and passed to ports as one object. PR 3 then adds
  `principal` (resolved from the connection, never from input) and PR 7 adds
  `org` to that one type, instead of to every signature.
- **`Forge`.** `gh` is spawned from two places, each with its own private
  `gh()` wrapper behind the `$ODU_GH_BIN` seam: the coordinator's statuses
  module (`sendGh`, `listStatuses`) and the CLI's protect port (default
  branch lookup, ruleset read and write). This PR makes the forge a port
  bound at the composition root, with the user's `gh` as its only
  implementation: `postStatus`, `listStatuses`, `defaultBranch`,
  `readRuleset`, `writeRuleset`. The statuses module's injectable seam
  becomes that port, and the credential decision leaves the coordinator. PR 8 binds an installation-token implementation and
  PRs 9 and 10 add forges without touching coordinator code.
- **Serving options in one place.** `web.ts` assembles kolu's
  `ServeSurfaceAppOptions` inline in the lifecycle function. This PR lifts
  the assembly into its own module so PR 1 adds a routes layer and PR 3 adds
  `middleware`, `upgradeHeaders` and `services` by adding parts, not by
  editing the gate-claim and teardown code around them.

What this PR deliberately does not do: introduce a database, a principal
type with any field, an org, or any cache code. A slot is not a feature.

Kolu needs no PR 0. Its websocket link takes a `connect` factory, so a Bun
or Node client can send `Authorization: Bearer` on the upgrade for PR 3 with
no framework change, and the browser carries the cookie. The one kolu change
stays where it is: the publish-closure push target before PR 2.

State of master after merge: identical behaviour, and the three seams the
next eight PRs plug into exist with one implementation each.

### PR 1: odu serves a Nix binary cache

> **Docs:** `odu web` now also serves Nix binary caches. Create one with
> `odu cache create <bucket>`; it prints the substituter URL and the public
> key to put in your `nix.conf` or `flake.nix`. Mint a write token with
> `odu cache token mint <bucket> --write` (shown once) and save it with
> `odu cache login <origin>`, or export it as `ODU_CACHE_TOKEN` in CI; then
> `odu cache push <bucket> ./result` pushes only what the bucket is missing.
> Prefer plain Nix? `odu cache use <bucket>` also prints the two netrc lines,
> after which `nix copy --to https://<host>/<bucket> ./result` works, or put
> the token in the URL as `https://x:$TOKEN@<host>/<bucket>`. Revoke tokens
> with `odu cache token revoke`, protect a closure from garbage collection
> with `odu cache pin`, reclaim space with `odu cache gc`, and see sizes and
> hit counts with `odu cache stats`. Administration needs the root token in
> `$ODU_ROOT_TOKEN`; the cache listens on loopback only.

What lands:
- New workspace member `packages/cache` with its own closure test: narinfo
  and NAR codec, the Nix-store blob store (import through the daemon, stream
  on read, gcroots for retention), SQLite metadata behind the repository
  layer, per-bucket ed25519 signing on ingest, hashed opaque tokens with
  scope, expiry and revocation, and GC with retention, references and pins.
- The protocol routes as one `HttpRouter` layer merged in `web.ts` (F1):
  `nix-cache-info`, narinfo HEAD/GET, NAR GET, PUT for both with Bearer or
  Basic, and the batched missing-paths endpoint.
- Surface verbs `cache_create`, `cache_list`, `cache_token_mint`,
  `cache_token_revoke`, `cache_pin`, `cache_gc`, `cache_stats`, authorised
  by a root token the service reads from its environment, and exposed to
  CLI, MCP and the board's data layer like every other verb (F4).
- CLI: `odu cache create | list | token | use | pin | gc | stats | push`.
  `push` is the one client of the cache's HTTP API rather than of the service,
  and the authority test gains the sentence that says why it is admissible.
- README, docs page and the odu skill updated for the new verbs (the repo's
  docs-sync rule), and e2e coverage: `nix copy --to` into a bucket, `nix
  build` substituting from it with the bucket's key trusted, GC evicting an
  unreferenced path and refusing a pinned closure.

**Exit criterion:** flat server memory over concurrent multi-gigabyte NAR reads
and pushes, shown by the evidence recording.

State of master after merge: `odu web` on any machine is also a Nix cache on
loopback, administered by `odu cache` with a root token. Nothing is public.

### PR 2: odu runs its own cache

> **Docs:** Run odu as a public cache on NixOS with `services.odu.enable =
> true`, a domain, and a root-token secret file; nginx and ACME are set up
> for you, and only the cache paths are exposed. Odu's own builds are served
> from such a bucket: add the substituter and key from the README to your
> `nix.conf` to pull odu and its runners from it. Open-source repos push to
> a bucket from GitHub Actions with the documented step and an
> `ODU_CACHE_TOKEN` secret.

The root token comes from `ODU_ROOT_TOKEN`, which the module sets from a secret
path (agenix-compatible) rather than from anything odu writes.

Prerequisite PR in kolu: `publish-closure` gains a generic push target (a
cache URL with netrc, or a push command) beside its attic inputs.

What lands:
- `services.odu` NixOS module: systemd unit under a service user, that
  service user in `nix.settings.trusted-users`, state directory,
  root-token secret file, the public key, and an nginx vhost with ACME that
  proxies **only** `/<bucket>/*` and `/_odu/v1/*`, with `proxy_cache` on NAR
  reads. The board, websocket and `/mcp` stay on
  loopback (F2). A NixOS VM test exercises the module end to end: create a
  bucket, push, substitute, GC.
- The dedicated server is deployed from this branch before merge, and the
  PR's evidence shows it.
- The dogfood switch (F9, F11): `flake.nix` `nixConfig` names the bucket;
  `nix-cache.yml` substitutes from it and pushes with `odu cache push` (or
  `nix copy` with netrc at bootstrap) using an `ODU_CACHE_TOKEN` secret, and
  its publish job uses the new kolu push target; odu's own lane hosts trust
  the bucket; docs name it.

State of master after merge: a public OSS cache exists, odu's own checks and
runner provisioning substitute from it, and `git grep cache.nixos.asia`
returns nothing. Other OSS repos can adopt it with the documented Actions
step.

### PR 3: server mode

> **Docs:** The board is now reachable on the server's domain behind a
> "Sign in with GitHub" button. Signed-in members see the runs and buckets;
> admins control them. Create a personal access token from your profile page
> and use the CLI or MCP against the server with `odu --origin
> https://<domain>` and `$ODU_TOKEN`. Signing out ends your live sessions
> everywhere. A local `odu web` without a domain works exactly as before.

What lands:
- A session table in the cache's SQLite, GitHub OAuth routes, and a
  `CurrentPrincipal` service provided per websocket from the `cookie`
  upgrade header through kolu's `services(connection)` seam (F1); the HTTP
  middleware resolves `Authorization: Bearer` for `/mcp` and the admin routes.
- Every surface verb takes the principal; the root token becomes the first
  owner's bootstrap. Logout and expiry close that principal's sockets.
- Personal access tokens for CLI and MCP against a remote `--origin` (F10
  becomes safe), and the loopback mode untouched, with its tests as the guard.
- The module exposes the board, websocket and `/mcp` through nginx.

State of master after merge: the dedicated server has an authenticated public
board. One org, the operator's; the cache and runs are visible to its members
and controllable by its admins.

### PR 4: teams

> **Docs:** Teams are organisations. An org owner creates it, adds members
> from a GitHub org or team or by invite, and assigns owner, admin or member
> roles. Each org owns any number of buckets, public or private; a private
> bucket is read with a token in your `netrc`. The bucket page shows paths,
> usage against the org's quota, and the tokens that can write to it, with
> one-click revocation. Every admin action is in the org's audit log.

What lands:
- Orgs, membership from GitHub org or team or by invite, roles (owner,
  admin, member); many buckets per org; private buckets with netrc reads;
  org field on runs and buckets so the catalog filters per org (F3).
- Bucket pages, token management with revocation in the UI, per-org usage
  and quotas, audit log.

State of master after merge: an internal team self-serves a private bucket,
mints and revokes tokens, and sees its usage, without the operator.

### PR 5: the hook

> **Docs:** Builds on a lane host are pushed to the bucket automatically.
> On NixOS set `services.odu.lane.bucket` and a token file; on other hosts
> install `odu cache hook` as the Nix `post-build-hook` and run
> `odu cache hookd`. Nothing changes in your recipes or workflows, and a
> cache outage never fails a build: paths queue locally and are pushed when
> the cache is back.

What lands:
- `odu cache hook`, a Nix `post-build-hook` that appends `OUT_PATHS` to a
  crash-safe local queue and returns, and `odu cache hookd`, which drains it
  with batching, missing-path queries and retries.
- `services.odu.lane` module option that installs both and holds the host's
  own write token (F5, F6 intact), used by the dedicated server's localhost
  lane; documentation for non-NixOS hosts.

State of master after merge: every build on a configured lane lands in the
bucket with no step in any recipe or workflow.

### PR 6: run-scoped push and provenance

> **Docs:** `odu run --push <bucket>` pushes each recipe's `result` closure
> as the recipe finishes, on any lane, with a token that lives only as long
> as the run. The run page lists what it pushed, and a path on the bucket
> page links back to the run and commit that built it. Mark a recipe
> `[metadata("odu:pin")]` to keep its closure out of garbage collection.

What lands:
- `odu run --push <bucket>`: `LaunchRequest` gains `push`, the service mints
  a write-only, single-bucket, run-lifetime token, the runner pushes each
  recipe's `result*` closure after the recipe and reports pushed paths on the
  lane surface; the catalog records them. The bounded relaxation of F6 is
  documented where the token is minted.
- Board and `run_read` show per-run pushes; a path on a bucket page links to
  the run that produced it; `[metadata("odu:pin")]` pins a recipe's closure.

State of master after merge: a lane without the hook still pushes, and every
cached path can be traced to the run that built it.

### PR 7: repositories and org-scoped venues

> **Docs:** Register a repository with your org and odu keeps its own clone.
> Start a run on any commit from the board or with `odu run --origin
> <server> --repo <name> --sha <sha>`, with no checkout on your machine. Lane
> hosts and leases now belong to the org and are managed from its settings
> page; `~/.config/odu/hosts.json` still drives a local `odu web`.

What lands:
- Repositories as a concept: an org registers a repo, the service keeps a
  managed clone under its state dir and fetches on demand; `run.start`
  accepts a repository and SHA as well as an absolute checkout (F7).
- Hosts and leases belong to an org (F8); the in-house VM pool is one org's
  inventory; `hosts.json` remains the loopback mode's source.

State of master after merge: a member starts a run on a registered repo at a
SHA from the board or `odu run --origin`, on the org's own lanes, with no
developer checkout involved.

### PR 8: the GitHub App

> **Docs:** Install the odu GitHub App on a repository and every push and
> pull request gets odu's checks, with no workflow file. Checks are posted
> by the App, so no personal `gh` login is involved, and `odu protect` uses
> the same identity. GitHub Actions jobs that still need to push can
> exchange their OIDC token for a short-lived bucket token instead of
> storing a secret.

What lands:
- Webhook receiver for push, pull_request and check re-run; each starts a
  run on the managed clone at the delivered SHA.
- Checks posted through an installation token bound to the statuses send
  seam (F6); `odu protect` moves to the same token.
- OIDC token exchange so GitHub Actions jobs push with a short-lived token
  and no stored secret.

State of master after merge: a repo with the App installed and no workflow
file gets checks and cache pushes on every PR.

### PR 9: Bitbucket, and PR 10: Jenkins

> **Docs:** Connect a Bitbucket workspace, or point a Jenkins job at odu's
> webhook, and runs start and report back the same way they do for GitHub.

Each is one adapter over the port PR 8 defines: a source event in, a status
out. Nothing else changes.

### PR 11: object storage

> **Docs:** Set `services.odu.cache.storage = "s3"` with a bucket and
> credentials to keep NARs in any S3-compatible store; clients download
> straight from it. `odu cache migrate` moves existing data between local
> disk and S3 without downtime.

The blob store's S3-compatible implementation with presigned GET redirects
and presigned PUT so uploads bypass the server, selected by the module; a
migration verb that moves blobs between stores.

### PR 12: Postgres

> **Docs:** Set `services.odu.database = "postgres"` with a connection
> string to run several odu servers against one database, behind one
> domain. SQLite remains the default for a single machine.

The repository layer's second implementation, selected by the module, with
the multi-node service it allows.

### PR 13: metrics, and PR 14: metering

> **Docs:** Scrape `/metrics` for cache hit rates, storage, run durations
> and lane utilisation. Each org's page shows its monthly storage, transfer
> and build minutes, and an operator can set limits and export the figures
> for billing.

Prometheus metrics for cache and runs; per-org metering and the billing hooks
a hosted offering needs.

## Risks and mitigations

- **Credentialed `nix copy` uploads** vary by Nix version. `odu cache push`
  is the supported path; the server also accepts Basic auth for Lix and newer
  Nix.
- **The first database in the tree** (F3). Keep the repository layer small so
  Postgres is a swap, and keep run evidence in the file catalog as it is.
- **Server mode touches every verb.** Thread the principal in PR 3 as one
  change, with the loopback mode's tests unchanged as the regression guard.
- **One box serving a thousand developers.** nginx `proxy_cache` from PR 2,
  presigned S3 redirects in PR 11.
- **Run-scoped push relaxes F6.** Bounded by scope, bucket and run lifetime,
  and the hook is the recommended path.
- **No chunking.** Deliberate; chutney showed chunking cost more than it saved
  on S3. Revisit only if storage cost dominates.
- **Streaming a NAR through Bun's HTTP server.** PR 1 hands the socket the
  store's `dump-path | zstd` stream and the request's own body stream, so no
  code path holds a NAR. That is only worth anything if the runtime honours
  backpressure on both, and Bun's `Bun.serve` is younger than Node's. The exit
  criterion (flat RSS over concurrent multi-gigabyte reads and pushes, recorded)
  is the measurement, not the assurance. Escape hatch if it does not hold:
  nginx `X-Accel-Redirect`, or a sidecar that serves NAR bytes while odu keeps
  narinfo, auth and signing.

## Open questions

- Should buckets map to GitHub repos, GitHub orgs, or be free-form under an
  org? Proposal: free-form under an org, with an optional repo link for
  provenance.
- Retention default for OSS buckets on the single server (proposal: 90 days,
  pins exempt).
