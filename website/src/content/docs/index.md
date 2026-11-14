---
title: Start here
description: odu runs a just CI pipeline on your own machines, shows every run in a browser, terminal or agent, and serves a Nix binary cache.
section: Start
order: 0
---

odu runs a `just` CI pipeline across local or remote machines. One local service lets you watch and control every run from a browser, a terminal or a coding agent. The same service serves a [Nix binary cache](/docs/cache/).

## Quick start

Nix is the only supported way to run odu. You need a repository whose `justfile` tags one recipe `[metadata("ci")]`.

1. Find your Nix system:

   ```sh
   nix eval --impure --raw --expr builtins.currentSystem
   ```

2. From the repository, run its pipeline on this machine:

   ```sh
   nix run github:juspay/odu -- ci run --host x86_64-linux=localhost --no-post
   ```

   Replace `x86_64-linux` with your system. `--host SYSTEM=localhost` allows CI on your workstation, and `--no-post` keeps it off GitHub.

3. Open **http://127.0.0.1:18440**. The command starts the service, creates a run and watches it. <kbd>Ctrl</kbd> + <kbd>C</kbd> stops watching, and CI continues.

The checkout must be clean. To run uncommitted changes, see [Run uncommitted changes](/docs/daily-workflow/#run-uncommitted-changes).

The examples on these pages use `odu` as shorthand for `nix run github:juspay/odu --`.

## Every run at once: the web service

```sh
odu web                 # serve in this terminal
odu web --background    # explicitly start or reuse a daemon
odu web --upgrade       # replace the existing service, serve here
```

The default address is **http://127.0.0.1:18440**. If a service already exists, bare `web` refuses; open its URL or replace it. Ctrl-C stops a foreground server, not its CI runs.

Foreground `odu web` prints the cache row's operational `info` lines—migration, CA pass, NAR served, refusals—while keeping the host's own narration quiet; [The cache page](cache/#operating-it) lists them.


The board lists runs across repositories. Open a run to inspect nodes, follow logs, select an earlier attempt, retry a failure, or cancel work. CLI and MCP clients use the same run IDs and state.

### The board and the API do everything the CLI does

The CLI keeps only what is shell-native: the `ci` commands, `odu cache push`/`login`/`use`/`target`, and `odu auth login`. **Cache, people and tunnel administration is the board or the API, not the CLI.** An admin creates a bucket from the Cache view — with the upstream switch that `"upstreamKeys": []` spells on the API — mints, lists and revokes its tokens, sets retention, pins and unpins a closure, reads what the next collection would take and runs GC without a terminal; an owner opens a people page, sees who is in, and grants or changes a role. Anything the board does, `odu surface <row> <verb> --input '{…}' --json` does from a shell.

A control is **drawn** by the role the page reads off your connection and **refused** by the row on its own, so a hidden button is never the only check. An empty field is refused when you press, with the reason, rather than greying the button out.

### Access through Tailscale or a proxy

Configure forwarding separately; Odu can keep listening on loopback. The service answers to whatever name it is reached by, so an SSH forward, a Tailscale name, or a proxy that passes the Host header through needs no configuration. In the loopback shape, anyone who can reach the forwarded address can control CI; configure [Server mode](#server-mode) and they meet a sign-in page instead.

A proxy that rewrites Host sends a browser Origin that no longer matches it. Admit that origin when starting the service — `services.odu.allowedOrigins` is the module's spelling of the same setting:

```sh
ODU_WEB_ALLOWED_ORIGINS=https://box.tailnet.ts.net \
  nix run github:juspay/odu -- web --upgrade
```

This replaces the existing service in the foreground. The setting is read at server startup; separate multiple origins with commas. `ODU_WEB_ORIGIN` instead changes the listener's address and service identity, and `ODU_PUBLIC_ORIGIN` names the address a bucket is published under when a proxy stands in front — see [Self-host on NixOS](#self-host-on-nixos).

### Self-host on NixOS

The board, the CI runs and the cache are one process, so the flake ships a NixOS module for all three. Add the flake and import it:

```nix
{
  inputs.odu.url = "github:juspay/odu";
}
```

```nix
{ config, inputs, ... }:
{
  imports = [ inputs.odu.nixosModules.default ];

  # `cache.enableACME` is on by default, and Let's Encrypt wants both of these.
  # Accepting the terms is your act, not the module's.
  security.acme = {
    acceptTerms = true;
    defaults.email = "you@example.com";
  };

  # Any secret file works. agenix is the example.
  age.secrets.odu-root-token = {
    file = ./secrets/odu-root-token.age;
    owner = "odu";
    mode = "0400";
  };

  services.odu = {
    enable = true;
    cache.domain = "cache.example.com";
    rootTokenFile = config.age.secrets.odu-root-token.path;
    openFirewall = true;
  };
}
```

What that does, in five sentences. The daemon binds loopback and runs as the `odu` system user, with its state in `/var/lib/odu` at mode 0700 — the cache's signing keys are in there. The root token arrives as a systemd credential and is exported into the unit's environment, never written into the Nix store. nginx serves one virtual host that proxies `/cache/`, `/_odu/v1/` and `/metrics` and answers 404 to everything else, so **the board and `/mcp`, which have no authentication in this release, stay off the public internet**. `cache.domain` also sets the origin a bucket publishes, so the URL `odu cache use` prints is the one your clients can reach.

Reach the board over a tailnet or an SSH forward to `127.0.0.1:18440`, then create the bucket and mint a token:

```sh
export ODU_ROOT_TOKEN=...
odu surface cache bucket_create --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","name":"main","public":true,"retentionDays":30}' --json
odu surface cache token_mint --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","bucket":"main","scope":"write"}' --json
```

On a client, trust the bucket — the key `bucket_create` printed:

```nix
{
  nix.settings = {
    extra-substituters = [ "https://cache.example.com/cache/main" ];
    extra-trusted-public-keys = [ "main-1:<public-key>" ];
  };
}
```

A bucket can keep its objects **on S3 instead of the server's disk** — Cloudflare R2, AWS, Garage or versitygw. Declare the store and name it at creation:

```nix
services.odu.cache.stores.r2 = {
  endpoint = "https://<account>.r2.cloudflarestorage.com";
  bucket = "odu-cache";
  region = "auto";
  credentialsFile = config.age.secrets.odu-r2.path; # AWS_ACCESS_KEY_ID=… / AWS_SECRET_ACCESS_KEY=…
};
```

then add `"store":"r2"` to the `bucket_create` input. The credentials are a systemd credential, like the root token; [Keep a bucket on S3](cache/#keep-a-bucket-on-s3) has the rest.

A bucket can also have **a name of its own** — `https://cache.kolu.dev` — served at the root of that name through a Cloudflare Tunnel, with no port opened. That needs a Cloudflare API token (`services.odu.cloudflare.apiTokenFile`) and the name set on the bucket (`cache.bucketDomains` gives it a vhost and a certificate on a module host); [A domain for a bucket](cache/#a-domain-for-a-bucket) has the whole walk. The same tunnel carries `ODU_PUBLIC_ORIGIN`'s host when the token can edit its zone, which is what lets a Funnel retire — and the App's callback then moves with `publicOrigin`.

`ODU_PUBLIC_ORIGIN` is the setting behind that URL: it names the address a bucket is published under when a proxy stands in front, and defaults to what `cache.domain` and `cache.enableACME` imply. The module requires a loopback `listen`, because the daemon has to sit behind a proxy: without `services.odu.github` nothing authenticates a request at all, and with it the session cookie wants TLS. Those are the two shapes — the second is [Server mode](#server-mode).

**Without the module.** A container or any non-systemd host runs the same one process from the environment the module sets, and needs nothing else. `ODU_STATE_DIR` holds everything — the run catalog, the cache, and the daemon's own gate and socket, which is what a read-only `$HOME` otherwise breaks. `ODU_WEB_ORIGIN` is the address it binds, `ODU_PUBLIC_ORIGIN` the one a bucket's URL is published at, and `ODU_ROOT_TOKEN` the administration secret; `ODU_OBJECT_STORES` names a JSON file of declared S3 stores, the shape the module writes. The cache stores the compressed NARs under `<state>/cache/objects`; disk is those objects plus staging for the largest in-flight NAR, memory is constant per NAR, and a `--no-upstream` bucket also stores the upstream closures it is pushed.

**Disk does not grow forever.** A bucket keeps what nobody wants for 90 days by default (`retentionDays` at `cache bucket_create`, and the bucket page's **Retention** afterwards), counted from the last time somebody *wanted* a path — a push of it, or the `missing` query a push asks first. A read never renews that clock, because reads are leaving odu and a clock a read wound would make the busiest paths the first to look idle. The row collects every bucket once a day on its own, and nothing is evicted while retention holds, something retained references it, or a pin holds it; **Dry run** on a bucket page says what the next collection would take, and **dry run retention days** beside it asks that question at a retention of your own (`retentionDays` on `cache_gc_plan`; blank is the bucket's own, `0` is what nothing references and no pin holds). The plan writes nothing, and `cache_gc_run` takes no such field, so an answer the dry run gave can never become a collection by another name. A pin holds a closure by name and a push re-points it (`pin: true` in the push action, `--pin NAME` from a shell), which is how a repository keeps its default branch's closure. [Keep and reclaim](cache/#keep-and-reclaim) has the rest.

### Metrics

`GET /metrics` is a Prometheus text exposition of the whole daemon. It is never anonymous: a scrape carries `Authorization: Bearer` with either the root token or a **metrics token** — a read-only credential that opens this route and nothing else, so a Prometheus never holds the secret that administers the server.

```sh
odu surface metrics token_mint --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","label":"prometheus-pod"}' --json
curl -H "Authorization: Bearer $METRICS_TOKEN" https://cache.example.com/metrics
```

The plaintext is answered once and only a sha256 of it is kept, in `<state>/metrics/tokens.json` (owner-only). `metrics_token_list` names every token and when it was last used; `metrics_token_revoke` ends one immediately, with no restart. All three need the root token, and a daemon started without one serves no metrics at all.

Each row contributes its own numbers; the host renders them.

| Metric | Type | Labels | From |
| --- | --- | --- | --- |
| `odu_cache_requests_total` | counter | `bucket`, `kind` (`narinfo`\|`nar`), `outcome` (`hit`\|`miss`\|`redirect`\|`refused`) | the cache row's served requests |
| `odu_cache_bytes_total` | counter | `bucket`, `direction` (`served`\|`uploaded`), `mode` | NARs served and uploaded |
| `odu_cache_uploads_total` | counter | `bucket`, `mode`, `outcome` (`recorded`\|`failed`) | pushes and imports |
| `odu_cache_gc_evicted_total`, `odu_cache_gc_runs_total` | counter | `bucket` / — | collections |
| `odu_cache_hits` | gauge | `bucket` | `SUM(hits)` over the paths a bucket holds **now** — a collection lowers it, which is why it is not a `_total` |
| `odu_cache_paths`, `odu_cache_bytes`, `odu_cache_pins` | gauge | `bucket` | SQL, read at the scrape |
| `odu_cache_last_gc_timestamp_seconds` | gauge | — | the last collection **since boot**; `0` when there has been none |
| `odu_runs_total` | counter | `outcome` | the on-disk catalog, each run counted once |
| `odu_run_duration_seconds` | histogram | `outcome` | verdicts, 10s…2h buckets |
| `odu_node_duration_seconds` | histogram | `recipe`, `platform`, `outcome` | journal `node_status`, each entry folded once |
| `odu_lane_reachable`, `odu_lane_held` | gauge | `host`, `platform` / `host` | the last venue probe; absent until something has probed |
| `odu_metrics_contributor_up` | gauge | `contributor` | `0` when a row failed this scrape — the scrape is still served |
| `odu_unhandled_total` | counter | `kind` (`rejection`\|`exception`) | rejections and exceptions the daemon caught and kept serving through — both labels present from the first scrape |

**Counters are process-local** and reset when the daemon restarts; that is standard, and `rate()` handles it. The numbers that must survive a restart are gauges read from storage. The catalog walk is bounded (the 200 newest runs, repeated at most every ten seconds), so a scrape costs the same on a catalog of ten thousand runs as on one of two hundred — and what it *publishes* is not that window: each run and each journal entry is folded **once** into totals that only grow, because a counter read off a sliding window falls every time a run leaves it, and a scraper reads a fall as a reset. The run totals therefore start at whatever the window held when the daemon started.


### Upgrading from a store-backed cache

1. **Module deployment:** leave `ODU_CACHE_STORE` unset — the old objects are the host's `/nix/store`. **Container:** point `ODU_CACHE_STORE` at the old chroot store.
2. Boot starts serving at once; the migration and the CA pass are row-scoped background tasks. Watch `cache.migration.*` and `cache.self_ca.*`.
3. Wait for `cache.migration.complete`.
4. **Module:** delete the abandoned roots under `<state>/cache/gcroots`, then run `nix-collect-garbage`. **Container:** delete the old store directory. Never delete `/nix/store` itself.
5. Rows the old store lacks stay objectless and answer 404 until re-pushed: each is named by a `cache.migration.object_failed` line, and `cache.migration.incomplete` carries the counts.

A chunked upload that sends `x-odu-upload` owns its parts, so concurrent pushers of one path never mix them; one that does not keeps the shared part names.

### Contract versions

Each row versions its own surface. The daemon publishes the host's version and every mounted row's on its identity cell (`rows`). A client is admitted when the host's major and the major of **every row it reads** match. A row it does not read is never consulted, so a cache change never refuses kolu or `odu ci run`. A refusal names the row, the version the daemon serves and the one the build reads. It also says when a needed row is not mounted.

| Row | Contract | Who reads it |
| --- | --- | --- |
| host (control, identity cell, admission) | 2.5 | every client |
| `ci` (runs) | **2.6** | `odu ci run`/`ci wait`/`ci logs`, MCP, the board, kolu |
| `cache` | **4.9** | `odu cache`, `odu surface cache`, the board |
| `auth` | 2.4 | `odu auth login`, `odu surface auth`, the board when there is a door |
| `cloudflare` | 2.4 | `odu surface cloudflare`, the board when there is a tunnel |
| `metrics` (the host's own fragment) | **1.0** | `odu surface metrics`, a Prometheus at `/metrics` |

Cache **3.0** removed the deprecated `held` list, its `/held` route and `odu cache push --wait`; **3.1** adds a bucket's `store`, `store` on `cache_bucket_create`, and the `stores` resource; **4.0** runs retention on `lastWanted` and drops the last-access field a path and `cache_stats_read` used to carry, and adds `cache_bucket_retention`, `cache_pin_list`, `cache_pin_delete`, `cache_gc_plan` and `orphans` on the GC report (`retentionDays` at creation is now optional, defaulting to 90 days); **4.1** adds `readsFrom` on a bucket row and on `cache_bucket_describe`, `publicUrl` on a declared store, `migration` on a bucket row, and `cache_bucket_migrate`, which moves a bucket's objects between stores; **4.2** adds `writesTo` on a bucket row — `"store"` when `odu cache push` uploads straight into the bucket's store through presigned URLs and odu reads the object back to verify it, `"odu"` when the bytes cross the daemon — and the upload negotiation the push client speaks to learn it; **4.3** adds `cache_bucket_delete`, which takes a bucket's objects out of its store and then deletes the bucket with its paths, pins and its own tokens; **4.4** adds an optional `retentionDays` to `cache_gc_plan` alone, so a dry run can ask what another retention would take without writing one — `cache_gc_run` does not take it; **4.5** adds `group`, `name`, `sort` and `descending` to `cache_bucket_paths`, so a bucket is grouped by package and ordered by the row — counted over the whole bucket rather than over whichever page a reader holds. **4.6** adds a token's `label`, so the bucket page's Tokens list says `run <id>` for a credential odu minted for a run; **4.7** adds `run` and `commit` to a path and to a package's newest version on `cache_bucket_paths` — what the push said built it, two opaque strings the cache keeps and never resolves; **4.8** adds `stopped` to the GC report, one plain sentence or null: a collection deletes in batches and deletes a batch's objects before dropping its rows, so a store that refuses a delete stops the run with everything unconfirmed still recorded and asking again carries on; **4.9** adds `keptBy` to a path and to a package on `cache_bucket_paths` — `kind` (`pin`, `retention`, `reference`, `nothing`), the `pins` that hold it, the `via` path whose clock does, and `until` — the collector's own answer to "why is this still here, and when does it go", which names pins to every reader of the path list. Runs **2.5** adds a run's `push` — where it pushes and what it warmed — on a board row and on `run_read`/`run_wait`, and `pushed` on a node; **2.6** adds a run's `actor` — who started it, a login or `local` — on a board row and on `run_read`/`run_wait`. A minor version adds members; a major changes something a reader already uses. Each version is pinned to a fingerprint of its surface, so a change to a surface without a bump fails the tests.


## Server mode

Set a GitHub App's credentials and odu has a **door**: an anonymous browser meets a sign-in page, `/mcp` answers `401` without a token, and every verb runs as a signed-in person with a role. Unset, none of that exists — a loopback `odu web` behaves exactly as it did before.

| | |
| --- | --- |
| `ODU_GITHUB_CLIENT_ID` | the App's Client ID |
| `ODU_GITHUB_CLIENT_SECRET_FILE` | a file holding the App's client secret |
| `ODU_GITHUB_ALLOW` | who may sign in: `org:<name>`, `team:<org>/<slug>`, or a comma-separated list of GitHub logins |
| `ODU_GITHUB_ORIGIN`, `ODU_GITHUB_API` | default `https://github.com` and `https://api.github.com`; a GitHub Enterprise host otherwise |

All three of the first are required together. Half a configuration is refused at startup, because a daemon that silently stopped asking for sign-in would be a door that looks shut and is not.

### Create the GitHub App

A **GitHub App**, not an OAuth App: the App's permissions are the scope, and later releases use its installation token to post checks and sync membership. Create it once per odu instance — see [Two instances](#two-instances) below.

On GitHub's **New GitHub App** form, set:

| Field | Value |
| --- | --- |
| **GitHub App name** | anything unique on GitHub, e.g. `odu-yourorg` |
| **Homepage URL** | `https://<host>/`, or your repository's URL |
| **Identifying and authorizing users → Callback URL** | `https://<host>/auth/github/callback` — exactly, no trailing slash |
| **Identifying and authorizing users → Expire user authorization tokens** | **OFF**. odu does not store refresh tokens in this release; if this is on, a sign-in is refused with a page naming this setting rather than holding a token that dies in eight hours |
| **Identifying and authorizing users → Request user authorization (OAuth) during installation** | **ON** |
| **Webhook → Active** | **OFF** (no webhooks yet) |
| **Permissions → Organization → Members** | **Read-only** — membership for `org:` and `team:` rules is read with the person's own token, which needs this |
| **Permissions → Account → Email addresses** | **Read-only** |
| **Where can this GitHub App be installed?** | **Any account** |

Then **Generate a new client secret** — the App's **Credentials** tab in the left sidebar, section **Client secrets**. Copy two things: the **Client ID** (top of the page) and the secret (shown once).

GitHub's banner also says a **private key** must be generated before the App can be installed. This release does not read that key — only the Client ID and the client secret — so it is needed only when the allow-list has an `org:` or `team:` rule, which requires the App to be installed on that organisation; keep the downloaded `.pem` somewhere safe for later releases.

### Install it

An App is **owned** by an account and **installed** on organisations or accounts, and the two are separate. It may be owned by your personal account; that is fine.

- For `org:<name>` or `team:<org>/<slug>` rules, an **owner of that organisation** installs the App on it — install it on selected repositories, which is enough (odu reads membership, not code).
- For a rules list of logins (`ODU_GITHUB_ALLOW=srid,octocat`), no installation is needed at all.

### Configure odu

**NixOS module** — the public board and the cache on one hostname:

```nix
services.odu = {
  enable = true;
  cache.domain = "odu.example.com";
  rootTokenFile = config.age.secrets.odu-root-token.path;
  openFirewall = true;
  github = {
    clientId = "Iv1.0123456789abcdef";
    clientSecretFile = config.age.secrets.odu-github-client-secret.path;
    allow = [ "org:example" ];
  };
};
```

`github` set turns the module's nginx from "the cache routes and a 404" into "everything the daemon serves": the board, `/rpc/ws` (with the websocket upgrade) and `/mcp`, plus the cache's own paths. `publicOrigin` follows `cache.domain` (`https://odu.example.com`), so the App's callback is the one above.

**The pod** (the project's own deployment) — the same settings from the environment, with the secret synced like the root token:

```sh
ODU_PUBLIC_ORIGIN=https://odu-k3s.rooster-blues.ts.net
ODU_GITHUB_CLIENT_ID=...            # from the Secret
ODU_GITHUB_CLIENT_SECRET_FILE=/path/to/client-secret
ODU_GITHUB_ALLOW=org:juspay
```

**A bare `odu web`** — point it at a hostname it is reachable at, and open it in a browser:

```sh
ODU_PUBLIC_ORIGIN=http://localhost:18440 \
ODU_GITHUB_CLIENT_ID=... \
ODU_GITHUB_CLIENT_SECRET_FILE=./client-secret \
ODU_GITHUB_ALLOW=org:example \
  nix run github:juspay/odu -- web
```

The App's callback for that one is `http://localhost:18440/auth/github/callback`; GitHub allows a `localhost` callback, and the session cookie is not `Secure` there.

`ODU_GITHUB_ALLOW` takes a comma-separated list, and one example of each form:

```sh
ODU_GITHUB_ALLOW='org:juspay'                  # anyone in the organisation
ODU_GITHUB_ALLOW='team:juspay/platform'        # anyone on that team
ODU_GITHUB_ALLOW='srid,octocat'                # these logins, by name
ODU_GITHUB_ALLOW='org:juspay,srid'             # any rule may let you in
```

### First sign-in and the first owner

Open the board. It is the sign-in page; **Sign in with GitHub** authorises the App and lands you on the runs. A person the allow-list refuses sees a page saying so, quoting the list — not a redirect and not an empty board.

Everyone starts as a **member**: they see every run and every bucket, may start, retry and cancel runs, and may read the cache. An **admin** may also create buckets, mint and revoke cache tokens, pin and collect, and write branch protection. An **owner** grants roles. Roles are odu's, not GitHub's.

**The root token creates the FIRST owner, and only that.** On a fresh daemon, once:

```sh
# On the server, with $ODU_ROOT_TOKEN set in its environment.
odu surface auth user_grant --origin https://odu.example.com \
  --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","login":"srid","role":"owner"}' --json
```

After that the root token is spent — a second grant made with it is refused, whatever the role — and every further grant is an owner's, through that owner's own token:

```sh
odu auth login https://odu.example.com        # paste the owner's personal token
odu surface auth user_grant --origin https://odu.example.com \
  --input '{"login":"alice","role":"admin","rootToken":""}' --json   # or People on the board
```

Or from the board: an owner's rail has **People**, which lists who is in — every grant, and every login that has ever signed in (signing out does not remove you), with its role — and grants or changes a role from a select. `odu surface auth grant_list` prints the same list. The row refuses a grant that would leave the daemon with no owner: grant a second owner before stepping down.

That is the root token's only job on a daemon with a door: it is not a principal, and it cannot start a run or read a bucket.

### A token for a machine or an agent

Your name at the foot of the rail opens the **profile page**: your sessions and your personal access tokens. Create one — it is shown **once** — and either store it on a machine or hand it to an agent:

```sh
odu auth login https://odu.example.com      # paste the token; it is kept at ~/.config/odu/auth/credentials, mode 0600
odu surface auth user_whoami --origin https://odu.example.com --json
odu surface cache bucket_list --origin https://odu.example.com --json

# or, for an agent or CI, no login step:
ODU_TOKEN=odu_... odu mcp --origin https://odu.example.com
```

Every `odu` command, and the MCP bridge, send the token as `Authorization: Bearer` on the connection they open. `ODU_TOKEN` wins over a stored credential, so one shell can be somebody else.


Sessions last 30 days from the sign-in; using one does not extend it. The cache protocol does not change: public buckets are read without an account — and `odu cache use` reads a public bucket's facts from `GET /cache/<bucket>`, so it works before anybody has signed in — while pushes carry a bucket token as before.

### Two instances

One App per odu instance: the callback URL is a single address, and the client secret is the App's. Two servers need two Apps — each owned by the same personal account is fine, and transferring an App to an organisation later keeps its Client ID, so the secret and `ODU_GITHUB_CLIENT_ID` survive the move.

**The cache's verbs are a row of their own**, and their names carry its word — `cache_` — then the thing and the act. Every one was renamed when the cache became a surface served beside the runs rather than behind the service, so a script written against odu 1.5 needs this table:

| was | now | takes `rootToken` |
| --- | --- | --- |
| `cache_create` | `cache_bucket_create` | yes |
| `cache_list` | `cache_bucket_list` | yes |
| `cache_describe` | `cache_bucket_describe` | no |
| — | `cache_bucket_paths` | no |
| — | `cache_bucket_retention` (4.0) | yes |
| — | `cache_bucket_migrate` (4.1) | yes |
| — | `cache_bucket_delete` (4.3) | yes |
| `cache_tokenMint` | `cache_token_mint` | yes |
| `cache_tokenList` | `cache_token_list` | yes |
| `cache_tokenRevoke` | `cache_token_revoke` | yes |
| `cache_pin` | `cache_pin_create` | yes |
| — | `cache_pin_list` (4.0) | yes |
| — | `cache_pin_delete` (4.0) | yes |
| `cache_gc` | `cache_gc_run` | yes |
| — | `cache_gc_plan` (4.0, the dry run; `retentionDays` 4.4) | yes\* |
| `cache_stats` | `cache_stats_read` | yes |

The same rename reaches argv: `odu surface cache_create …` is `odu surface cache bucket_create …`, because a sibling's commands mount under its key — and that argv face is now how a cache is administered from a shell, the CLI's own `cache create`/`list`/`token`/`pin`/`gc`/`stats` having been retired. `odu cache push`/`login`/`use` — the shell-native commands — are unchanged. A service started without `$ODU_ROOT_TOKEN` refuses the token-taking verbs with `no_root_token` while the substituter keeps serving; `cache_bucket_describe` and `cache_bucket_paths` take no credential at all, because a bucket's URL, its key and its path list are what it publishes to every client that can read it. \*`cache_gc_plan` does take a `rootToken` like the other administrative verbs, but it is annotated read-only — an agent may ask what a collection would evict without a confirmation, and must not run one without.

## Find your page

| You want to | Read |
| --- | --- |
| <span id="use-odu-from-your-repository"></span>set up a repository to run on odu and push to its cache | [Use odu from your repository](/docs/your-repository/) |
| say which machines a run uses | [The machines a run uses](/docs/machines/) |
| <span id="daily-workflow"></span>run, watch, retry and read logs | [Daily workflow](/docs/daily-workflow/) |
| run the server's CI from your own shell | [Run the server's CI from your shell](/docs/remote-runs/) |
| <span id="coding-agents"></span><span id="coding-agents-mcp"></span>let a coding agent run CI, over the CLI or MCP | [Coding agents](/docs/agents/) |
| <span id="troubleshooting"></span>get past a refusal | [Troubleshooting](/docs/troubleshooting/) |
| <span id="every-run-at-once-the-web-service"></span>start the web service and use the board | [The web service and the board](/docs/web-service/) |
| <span id="access-through-tailscale-or-a-proxy"></span>reach the board through Tailscale or a proxy | [Access through Tailscale or a proxy](/docs/web-service/#access-through-tailscale-or-a-proxy) |
| <span id="self-host-on-nixos"></span>run odu on a NixOS server | [Self-host on NixOS](/docs/self-host/) |
| <span id="server-mode"></span>put GitHub sign-in in front of the board | [Server mode](/docs/server-mode/) |
| <span id="metrics"></span>scrape odu with Prometheus | [Metrics](/docs/metrics/) |
| serve a Nix binary cache | [Nix binary cache](/docs/cache/) |
| <span id="cli-reference"></span>look up a command, its API verb and its exit codes | [CLI reference](/docs/cli/) |
| <span id="contract-versions"></span>check which versions a client and the service must share | [Contract versions](/docs/contract-versions/) |
