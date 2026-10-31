# Odu as a product: Nix cache + CI you run yourself

Status: living, 2026-10-31. PR 0, PR 1 and PR 1.5 are on master; the next PR is
server mode. Decisions below were taken in conversation. There is no schedule:
one phase is one PR, and the split is grounded in the source facts listed in
"What the code is today".

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
- **Identity:** a **GitHub App** installed on the org, through GitHub's
  authorisation-code flow (the user flow now; installation tokens later —
  PR 4 and PR 8). Admin-issued personal tokens for anything that is not a
  person, for the OSS stage; generic OIDC (Google Workspace) for internal
  teams later.
- **CI trigger:** GitHub App webhooks, pipelines remain the CI-tagged
  justfile. Bitbucket/Jenkins as later webhook adapters.
- **v1 hosting:** one process, local disk. Two shapes exist: the
  `services.odu` NixOS module (PR 1) for anyone, and our own deployment, a
  K3s pod on `pureintent` behind a Tailscale ingress (nixos-config
  `k8s/apps/odu`, F12). The pod is where every PR is dogfooded before merge.
  S3 and runner pools later.
- **Order of identity and public cache:** server mode (PR 2) lands before the
  public cache (PR 3). A public cache is administered over the network, and
  the pod has no nginx to hide the board behind, so the moment the ingress is
  public, odu itself must know who is asking.
- **First users:** OSS projects (single public bucket), then internal teams.
  Migration tooling from Attic is out of scope.

## What the code is today (facts the PRs are built on)

Each item names where it is checked.

- **F1. HTTP server.** `odu web` serves through kolu's `serveSurfaceApp`
  (`packages/host/src/web.ts`). App routes are one Effect `HttpRouter` layer
  merged beside the shell (`routes: Layer.merge(mcpRoute, mcpGetRoute)`),
  and the framework exposes an HTTP `middleware` seam, a `tls` option, an
  `upgradeHeaders` allowlist, and a `services(connection)` seam that provides
  a per-websocket Effect layer to that connection's handlers (kolu master,
  `packages/surface-app/src/serve.ts`). kolu-server already uses exactly this
  to provide a per-connection `CurrentViewer` service from `x-forwarded-for`
  (`packages/server/src/index.ts`, `router.ts`). Nothing in kolu does cookies,
  OAuth or Bearer tokens. Cache routes are one more layer; a principal is one
  more per-connection service, in odu.
- **F2. No identity anywhere but the cache's tokens.** The service is a
  per-user singleton: gate and home under the state directory (mode 0700), one
  fixed origin, an Origin allowlist for the websocket and `/mcp`, and a root
  token in `ODU_ROOT_TOKEN` that authorises the cache's admin verbs. Anyone who
  reaches the listener controls CI and reads every bucket's facts
  (`packages/host/src/web.ts`, docs "Access through Tailscale"). **PR 2 removes
  this fact for a configured daemon**: with `ODU_GITHUB_*` set, the listener
  asks who is on a connection and every verb runs as a principal; without it,
  everything above is still true, which is what makes loopback mode's tests the
  regression guard.
- **F3. One database, the cache's.** The run catalog is per-user append-only
  files under the state directory (`packages/run-history/src/paths.ts`,
  `store.ts`). PR 1 added `cache/cache.sqlite` behind `packages/cache`'s
  repository layer; it holds buckets, tokens, objects, pins and the signing
  keys, and nothing outside the cache row opens it.
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
- **F9. Packaging.** The flake exports `odu`, `odu-runner`, `web-ui` and the
  `services.odu` NixOS module (PR 1: service user, nginx with ACME proxying
  only `/cache/*` and `/_odu/v1/*`, a VM test). Its `nixConfig` still trusts
  `cache.nixos.asia/oss`, and macOS lanes need that cache trusted to pull the
  runner (docs "Choose hosts"), so odu's own flake is the first consumer of
  the new bucket.
- **F10. Remote dialling exists, unauthenticated.** Every client takes
  `--origin URL`; a named origin is dialled and never auto-started.
- **F11. How odu warms its own cache today.** `.github/workflows/nix-cache.yml`
  builds `.#odu .#odu-runner .#web-ui` on ubuntu and macos runners and pushes
  the closures with `attic push` to `cache.nixos.asia/oss` using an
  `ATTIC_TOKEN` secret; a second job runs kolu's `publish-closure` action,
  which rewrites the runner content-addressed, pushes it with the same attic
  token, and writes the `ca-index` branch a lane dial reads. The flake's
  `nixConfig`, the workflow's `nix_conf`, and the docs all name that cache.
  The repository has no `ATTIC_TOKEN` secret, so this workflow is red on
  every commit of master; PR 3 retires it.
- **F12. Our deployment is a pod, not the module.** nixos-config
  `k8s/apps/odu` runs `odu web` from the host's Nix store in `pureintent`'s
  K3s, one replica, a `local-path` PVC for the catalog and a chroot cache store
  (`ODU_CACHE_STORE=local?root=/data/cache-store`, so unsigned imports never
  touch the host daemon). It binds the pod address (`ODU_WEB_ORIGIN=
  http://0.0.0.0:18440`), publishes `https://odu-k3s.rooster-blues.ts.net`
  (`ODU_PUBLIC_ORIGIN`), and the Tailscale Ingress is the only way in, today
  as `tailscale serve` (tailnet only). There is no nginx: every path odu
  serves is reachable alike, and the root token arrives from a 1Password item
  through External Secrets. Buckets there are created `--no-upstream`,
  because a chroot store starts empty and the server cannot yet fetch a
  referrer's upstream-signed references itself.
- **F13. Two rows behind one fence.** After PR 1.5 the daemon is a host
  (`@odu/host`) composing two Cordis rows, `ci` and `cache`, each owning its
  surface, server, CLI and face; `@odu/cordis` holds the contract both read,
  and `packages/host/src/fence.test.ts` proves, with `@olai/effect-cordis/fence`,
  that only roots name rows. Who is on a connection is therefore a fact the
  HOST supplies through the contract package, and the feature that decides it
  (sign-in, sessions, tokens) is a row of its own that registers with the
  host; neither `ci` nor `cache` imports it.

Consequences for the split:

- The web board cannot go on the public internet before identity exists
  (F2), and our deployment has no nginx to expose the cache without the
  board (F12). So identity comes first: PR 2 is server mode, and PR 3 then
  makes the pod's ingress a public cache and odu its own first customer.
- "CI pushes for you" has two halves with different owners: the hook is host
  config (F5), and run-scoped push needs a token on the lane, which relaxes
  F6 and must be a scoped, short-lived, write-only token.
- Hosted CI needs server-managed clones (F7) and org-scoped hosts (F8) before
  a webhook can do anything. That is its own PR (PR 7), before the App.

## Architecture

### Protocol (per bucket, standard Nix)

```
GET  /cache/<bucket>/nix-cache-info        StoreDir, WantMassQuery: 1, Priority: 40
HEAD /cache/<bucket>/<hash>.narinfo
GET  /cache/<bucket>/<hash>.narinfo
GET  /cache/<bucket>/nar/<filehash>.nar.zst  stream, or 302 to presigned URL (PR 11)
PUT  /cache/<bucket>/nar/<filehash>.nar.<ext>  Bearer or Basic; any ext Nix sends (xz by default, zst with ?compression=zstd)
PUT  /cache/<bucket>/<hash>.narinfo        server re-signs with the bucket key; URL field kept as sent
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
`nixConfig` flake snippet are printed by `odu cache use <bucket>` and shown
on the bucket page (both landed).

### Storage

- **Blobs:** the server's own Nix store. `put` imports a NAR through the
  daemon (`nix-store --import` semantics; the service user is a trusted user
  on the module's machine), `get` streams `nix store dump-path` through zstd,
  `delete` drops odu's gcroot and runs `nix-store --delete`. Dedup across
  buckets is by store path, for free. No second copy on a single machine,
  which is the small-team shape and the developer's laptop. On-the-fly
  compression costs CPU per cold read; nginx `proxy_cache` (PR 3, module
  only) absorbs the repeats. S3-compatible storage is the second
  implementation in PR 11.
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
expiry, last-used, and single-token revocation. Today a root token (from the
environment) mints them over the surface; from PR 2 signed-in admins mint and
revoke in the UI or CLI, and the root token is only the bootstrap. Roles:
owner, admin, member.

### Where the cache lives in the process

The `cache` row: `@odu/cache` with four doors, `./surface` (the contract),
`./server` (protocol routes, blob store, SQLite, signing, tokens, GC),
`./cli` (`odu cache …`) and `./face` (the Cache view), composed by the host
beside the `ci` row (F13). Its admin operations are verbs on the composed
surface under the row's word (`cache_bucket_create`, `cache_token_mint`,
`cache_pin_create`, `cache_gc_run`, `cache_stats_read`, …), so `odu cache …`,
the browser and MCP all reach them through the service (F4). `odu cache push`
is the one command that is a client of a *different* authority: the cache's
HTTP API, with a token, from the machine that holds the paths.

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
   main thing `nix copy` cannot do. `nix copy --to https://…/cache/<bucket>` with
   netrc or a token in the URL stays for people who want nothing odu-specific
   (see "Credentials on the client"); it buffers each NAR in memory and
   probes paths one at a time. Known gaps against cachix and attic, kept
   deliberately: uploads go through the server until PR 11 adds presigned
   PUT; dedup is per store path, not per chunk; no watch mode until PR 5.
3. **Run-scoped (PR 6).** `odu run --push <bucket>`: the runner pushes each
   recipe's `result*` closures after the recipe, using a write-only token
   scoped to that bucket with a lifetime of the run. This is a deliberate,
   bounded relaxation of F6 and is documented as such.

### Server mode (PR 2)

Built on the seams F1 names, and decided: **the principal is odu's, and kolu
needs no change.** The TLS terminator owns the public name: nginx under the
module, the Tailscale ingress on the pod. odu names `cookie` in
`upgradeHeaders`, resolves the session in `services(connection)` and
provides a `CurrentPrincipal` service, the exact shape of kolu-server's
`CurrentViewer`; verbs read it from the `Caller` PR 0 gave them. The HTTP
`middleware` resolves `Authorization: Bearer` for `/mcp`; the cache protocol
routes keep checking their own per-bucket token per request, and public
bucket reads stay anonymous. One design point the seam forces: the session is
checked at upgrade only, so logout and expiry must close that principal's
open sockets, which odu owns through its session table. If a second kolu app
later needs a cookie principal, the helper moves into `@kolu/surface-app`;
not before.

Ownership, by the Cordis rules (olai `docs/architecture/cordis.md`):

- **The connection is the host's.** The host owns the listener, so it owns
  "who is on this connection": a `Principal` broker in `@odu/cordis`, always
  present, whose absence behaviour is stated — with no resolver registered,
  every connection is the local owner, which is loopback mode today. Rows
  read `CurrentPrincipal` (a service key, a safe import) and never ask who
  supplies it.
- **Sign-in is a row.** `auth` (`@odu/auth`, four doors like `cache`) owns
  the GitHub App's authorisation-code flow, the sessions and personal-token
  tables in its own
  `auth.sqlite`, the sign-in and profile faces, and `odu auth …`. It is
  optional in the doc's second sense: a provider that adds itself to its
  consumer. In its `apply` it registers its resolver on the host's
  single-owner key (a second claimant is refused) and its finalizer withdraws
  it, so the row can stop without the host, `ci` or `cache` noticing.
- **A session is acquired, not looked up.** At upgrade the host takes a lease
  on the session from the resolver and arranges the release in the same step;
  logout, expiry and revocation end the lease. **This is the one place the
  implementation had to differ from the plan**: kolu's `serveSurfaceApp` has no
  accept/reject hook and no public seam hands odu the socket, so the host
  cannot close a connection. What it does instead, and it is enough for the
  promise: an ended lease refuses EVERY member — the framework's reserved
  `system/live` heartbeat included — so the client's watchdog severs the
  socket, redials with the dead cookie, is refused at the upgrade, and comes
  back anonymous. Every later call on the old connection is refused and every
  open subscription is interrupted at the instant it ends. No revocation list
  is polled. **TODO(re-pin):** the socket itself is closed by
  `SurfaceAppConnection.close(code?, reason?)` (kolu PR #2330). odu's lease
  watch calls it — guarded, because the pinned kolu predates it — so the re-pin
  is the one change that makes the server cut the connection rather than the
  client's next load.
- **Roles are each row's rule.** `ci` decides what a `member` may start,
  `cache` what an `admin` may mint; `@odu/cordis` carries only the `Role`
  type. The root token stays what it is, the operator's bootstrap, and gains
  one job: granting the first `owner`.

Every surface verb receives a principal through `Caller`; the org arrives in
PR 4. Loopback mode stays as it is: no `auth` row mounted means every caller
is the local owner, same verbs, same board, and its tests are the guard.

### Deployment shapes

- **Small team, one NixOS machine:** `services.odu.enable`, local disk, the
  same box is cache, board and lane runner (localhost lane, hook configured by
  the same module).
- **Ours:** the K3s pod (F12): chroot cache store on a PVC, Tailscale Funnel
  as the public door from PR 2, lanes on the tailnet (`croissant`, `petit`).
- **Large team:** cache node(s) with S3 and Postgres; lane pool of the team's
  own machines or our in-house VMs; nginx `proxy_cache` and/or CDN in front of
  reads.
- **Hosted:** the large shape, multi-org, metered per org.

## Roadmap: one phase is one PR

There is no schedule. Each PR is substantial, merges green on both platforms
with evidence, and leaves master in a state someone can run and rely on. A
capability reaches the public surface only in the PR that completes it, and
nothing merges that a later PR has to finish. The order is a dependency order.

### Landed: PR 0, PR 1, PR 1.5

| PR | merged | what master gained |
| --- | --- | --- |
| 0 — the caller and the forge | #130 `ba42ac2` | `Caller` assembled once per call (where PR 2 adds `principal`, PR 4 `org`); the forge as a port with the user's `gh` as its one binding; serving options in a module of their own. No behaviour change. |
| 1 — odu serves a Nix binary cache | #132 `712eafe` | `packages/cache`: narinfo/NAR codec, Nix-store blobs, SQLite metadata, per-bucket signing, hashed scoped tokens, GC with pins; the protocol routes; `odu cache create · list · token · use · login · pin · gc · stats · push`; the `services.odu` module with its VM test; docs and e2e. Flat memory over multi-gigabyte NARs, recorded. |
| 1.5 — a host and two rows | #133 `4e0d621` | `@odu/host` (tenure, listener, gate, `/mcp`, composition root), `@odu/launch`, `@odu/ci`, `@odu/cordis` (the contract); the cache as a row with `./surface · ./server · ./cli · ./face`; the Cache view at `#/cache`; cache verbs renamed under the row's word and `SERVICE_CONTRACT_VERSION` 2.0; the fence from `@olai/effect-cordis`, pinned with npins. |

For users: `odu web` serves runs and buckets over one wire and one page, with
a Runs / Cache switch; `odu cache use <bucket>` prints the substituter, key
and netrc lines; `odu cache push` sends only what a bucket is missing; the
root token in `$ODU_ROOT_TOKEN` authorises administration; NixOS users set
`services.odu.enable` and get the cache paths behind nginx with ACME. The pod
(F12) runs #133 today.

### PR 2: server mode

> **Docs:** Your odu server now has a door. Open the board and you meet
> **Sign in with GitHub**; the operator decides which GitHub org, team or
> people may enter. Once in, members see every run and bucket and start runs;
> admins also create buckets, mint and revoke cache tokens, and run GC; the
> owner grants roles. Your profile page shows your sessions and lets you
> create a **personal access token**: run `odu auth login https://<host>` once
> with it, and every `odu` command and the MCP server reach that server with
> `--origin https://<host>`; or hand it to an agent as `$ODU_TOKEN`. Signing
> out, or revoking a token, ends those sessions everywhere at once, open
> browser tabs included. The cache protocol does not change: public buckets
> are read without an account, pushes carry a bucket token as before. A local
> `odu web` with no sign-in configured behaves exactly as it does today.

Why now: the pod's ingress goes public in PR 3, and nothing in the pod can
hide the board or `/mcp` from whoever reaches it (F12). Identity has to be
odu's own.

What lands:
- **The `auth` row** (`@odu/auth`, doors `./surface · ./server · ./cli ·
  ./face`, F13): the GitHub App's authorisation-code flow (state cookie, the
  callback at `/auth/github/callback`, no `scope` — the App's permissions are
  the scope), the sign-in page an anonymous browser meets
  instead of the board, sessions and personal access tokens in `auth.sqlite`
  under the state directory, membership from a GitHub org or team or a list
  of logins, the verbs `auth_user_whoami`, `auth_user_grant`,
  `auth_token_create`, `auth_token_list`, `auth_token_revoke`,
  `auth_session_list`, `auth_session_end`,
  and `odu auth login | whoami | token | grant`. **The framework mints
  `<row>_<noun>_<verb>`** (`surface/<row>/<noun>/<verb>` on the wire), so a
  verb with no noun between them — the `auth_whoami` this document first
  proposed — cannot exist; `user` is the noun the first two take, and the argv
  face keeps the short spelling. Configuration
  is environment (`ODU_GITHUB_CLIENT_ID`, `ODU_GITHUB_CLIENT_SECRET_FILE`,
  `ODU_GITHUB_ALLOW`); unset, the row is not mounted.
- **The `Principal` broker** in `@odu/cordis` and the host: resolved per
  websocket from the `cookie` upgrade header through kolu's
  `services(connection)` seam and per HTTP request from `Authorization:
  Bearer` through its `middleware` (F1). The `auth` row registers its
  resolver on the broker's single-owner key in `apply` and withdraws it in its
  finalizer; with none registered every caller is the local owner. `Caller`
  carries the principal to every verb of every row, and each row's own rule
  decides: `ci` state changes need `member`, cache administration `admin`,
  grants `owner`; the root token grants the first `owner` and nothing else.
- **Sessions are leases.** The host acquires a session lease at upgrade and
  arranges its release in the same step; logout, expiry and revocation end the
  lease, and the ended lease closes the connection. No revocation list is
  polled.
- **Personal access tokens** from the profile page or `odu auth token create`,
  stored per origin by `odu auth login` and sent as `Authorization: Bearer` on
  the upgrade by the CLI and MCP clients (kolu's `connect` factory, no
  framework change), so `--origin` against a remote server is safe at last
  (F10).
- **The board** reads `auth_user_whoami` through the wire: a signed-in header and
  the profile page from the `auth` face, and the Runs and Cache views hide the
  controls the role cannot use. With no `auth` row the header is as today.
- **The fence** gains a third row and the broker key's single-owner claim is
  tested: a second resolver is refused and installs nothing.
- **A row owns its promises.** As in olai (`packages/tests/cucumber.js`: "a
  feature is a promise, and a promise has an owner"), each row keeps its own
  `e2e/`: the cache's five browser scenarios and twelve CLI tests move from
  `packages/web-acceptance` and `tests/e2e` to `packages/cache/e2e`, the run
  views' to `packages/ci/e2e`, and `auth` arrives with its own; the two
  central places keep the harness (world, hooks, the service under test) and
  the shell's own features. One cucumber and one `bun test` still run it all.
  Scenarios declare their world by tag (`@signed-in:admin`, `@anonymous`, no
  tag means loopback), and the new promises are tested end to end: sign-in
  through a stubbed GitHub, an anonymous board meeting the sign-in page, a
  member refused a cache verb, a token minted on the profile page driving
  `odu --origin`, logout closing an open tab's socket, revocation and expiry.
- **Deployment, both shapes.** The module gains `services.odu.github.*` and
  exposes the board, websocket and `/mcp` through nginx. For the pod,
  nixos-config switches the ingress from `tailscale serve` to Funnel and
  syncs the GitHub App's client secret the same way as the root token; that
  change is a separate PR there, landed with the evidence below.
- **Evidence:** this branch deployed to the pod, a sign-in from a device
  outside the tailnet, a refused run from an anonymous MCP client, a token
  minted on the profile page driving `odu --origin` from a laptop.

State of master after merge: our deployment has an authenticated public
board over Funnel. One org, the operator's; runs and buckets are visible to
its members and controlled by its admins. Loopback mode is byte-for-byte what
it was.

### PR 3: odu runs its own cache

> **Docs:** Odu's own builds are served from its own cache: add the
> substituter and key from the README to your `nix.conf` to pull odu and its
> runners from it. A bucket on a server whose store is not the builder's no
> longer needs `--no-upstream`: the server fetches a referrer's upstream
> references itself. Open-source repos push to a bucket from GitHub Actions
> with the documented step and an `ODU_CACHE_TOKEN` secret minted by a
> signed-in admin. NixOS users get an nginx `proxy_cache` on NAR reads.

Prerequisite PR in kolu: `publish-closure` gains a generic push target (a
cache URL with netrc, or a push command) beside its attic inputs.

What lands:
- The server substitutes a referrer's upstream-signed references into its OWN
  store (`nix-store -r --store … --option substituters …`) before the narinfo
  is imported, so a chroot store (F12) keeps the upstream skip and still
  imports referrers. `--no-upstream` stays as the explicit choice it already
  is.
- The dogfood switch (F9, F11): `flake.nix` `nixConfig` names the pod's
  bucket; `nix-cache.yml` substitutes from it and pushes with `odu cache push`
  under an `ODU_CACHE_TOKEN` secret, its publish job uses the new kolu push
  target, odu's lane hosts trust the bucket, and the docs name it. The
  `ATTIC_TOKEN` job, red on every commit today, is gone.
- The module's nginx gains a `proxy_cache` on `/cache/*/nar/*`; the pod has no
  nginx and gets its read cache in PR 11.
- **Evidence:** a CI run of odu whose lanes substitute odu's runner from the
  pod, and the workflow's push landing in the bucket.

State of master after merge: a public OSS cache exists at the pod's address,
odu's own checks and runner provisioning substitute from it, and `git grep
cache.nixos.asia` returns nothing. Other OSS repos can adopt it with the
documented Actions step.

### PR 4: teams

> **Docs:** Teams are organisations. An org owner creates it, adds members
> from a GitHub org or team or by invite, and assigns owner, admin or member
> roles. Each org owns any number of buckets, public or private; a private
> bucket is read with a token in your `netrc`. The bucket page shows usage
> against the org's quota and the tokens that can write to it, with one-click
> revocation. Every admin action is in the org's audit log.

What lands:
- Orgs, membership from GitHub org or team or by invite, roles (owner,
  admin, member); many buckets per org; private buckets with netrc reads;
  org field on runs and buckets so the catalog filters per org (F3).
- Membership synced server-side from the App's installation token, so a
  removal in GitHub is a removal in odu; user-token expiry turned on with
  refresh tokens stored. PR 2 refuses an expiring user token rather than
  holding one that dies in eight hours, which is this PR's to fix.
- Token management with revocation in the UI, per-org usage and quotas, audit
  log. The bucket page itself is NOT here: PR 1.5 built it (a bucket's key,
  substituter URL, use block and paged paths), so this PR adds the org's facts
  to a page that exists rather than shipping one.

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
  own write token (F5, F6 intact), used by a module machine's localhost lane
  and by our tailnet lanes; documentation for non-NixOS hosts.

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

### PR 8: webhooks and check runs

> **Docs:** Install the odu GitHub App on a repository and every push and
> pull request gets odu's checks, with no workflow file. Checks are posted
> by the App, so no personal `gh` login is involved, and `odu protect` uses
> the same identity. GitHub Actions jobs that still need to push can
> exchange their OIDC token for a short-lived bucket token instead of
> storing a secret.

The App already exists — PR 2 created it, because sign-in is its user flow.
What this PR adds is the installation half.

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
- **Server mode touches every verb.** Thread the principal in PR 2 as one
  change, with the loopback mode's tests unchanged as the regression guard.
- **Funnel exposes everything the pod serves.** PR 2 ships no public door
  before the sign-in gate, Bearer on `/mcp` and role checks on every verb are
  in; the switch from `serve` to Funnel happens with PR 2's evidence, not
  before it.
- **One box serving a thousand developers.** nginx `proxy_cache` from PR 3 on
  the module, presigned S3 redirects in PR 11.
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
