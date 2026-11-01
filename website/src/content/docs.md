# Docs

Odu runs a `just` CI pipeline across local or remote machines. One local service lets you watch and control every run from a browser, terminal, or coding agent. The same service also serves a Nix binary cache; see [the binary cache docs](cache/).

## Quick start

**Nix is the only supported way to run Odu.** From a repository with a CI-tagged `justfile`:

```sh
nix run github:juspay/odu -- run --host x86_64-linux=localhost --no-post
```

Replace `x86_64-linux` with your Nix system (`nix eval --impure --raw --expr builtins.currentSystem`). This explicitly allows CI on your workstation. The checkout must be clean; `--no-strict` snapshots uncommitted edits and new files for local and remote lanes, excludes ignored files, and never posts to GitHub. Use `--no-snapshot` for in-place localhost runs.

Open **http://127.0.0.1:18440**. The command starts the shared service automatically, creates a run, and watches it. Ctrl-C stops watching; CI continues.

Examples below use `odu` as shorthand for `nix run github:juspay/odu --`.

## Configure your repo

Tag one root recipe. Its dependency graph is the pipeline:

```just
[metadata("ci")]
default: build test lint
```

Commit the justfile before a strict run. Each recipe should declare the dependencies it needs; Odu schedules the graph.

### Choose hosts

Pass `--host SYSTEM=localhost` for an explicit local run, or create `~/.config/odu/hosts.json`:

```json
{
  "x86_64-linux": ["ci@linux-a", "ci@linux-b"],
  "aarch64-darwin": "ci@mac"
}
```

A remote pool leases one available machine per platform. Builders need SSH access, Nix and outbound HTTPS. Each lane host also needs the lane runner built for its Nix system, which odu resolves from the build that shipped its own coordinator: a published revision reaches a Linux host on Nix 2.17–2.34 with **no cache key on the host** (the host pulls the content-addressed build itself), while macOS and other Nix lines need the binary cache odu's flake declares to be trusted. Do not mix localhost and remote machines in one pool.

Hosts are read from the first existing file: `$ODU_HOSTS`, `~/.config/odu/hosts.json`, then the legacy `~/.config/justci/hosts.json`. No configured host means a refusal, never an implicit local build.

On the board: **Machines** shows the service's last probe of the same inventory and its age — opening the page dials nothing — and **Probe machines** takes a fresh one, narrowed by platform if you name one.

```sh
odu hosts
odu run --platform x86_64-linux
odu run test@aarch64-darwin
```

The CLI forwards your shell's `$ODU_HOSTS`. A browser or MCP caller can supply `hostsFile`; omitted uses the service's configuration, while `""` bypasses its override. Retries preserve the parent's recorded inventory choice and host pins.

### Hold a machine across runs

```sh
odu lease x86_64-linux
odu run
odu release x86_64-linux
```

On the board: **Machines** → **Hold** / **Release**, for a checkout's absolute path. A lease belongs to the checkout and survives the calling shell. `lease` reports `held`, `already`, or `waiting`; use `hosts` to inspect capacity. Release it when finished.

### Shard a slow check

```just
[metadata("odu:shard=4")]
e2e: install
    CUCUMBER_SHARD="$((ODU_SHARD_INDEX + 1))/$ODU_SHARD_TOTAL" just test-e2e
```

Only leaf recipes can be sharded. Odu supplies a zero-based `ODU_SHARD_INDEX` and the actual `ODU_SHARD_TOTAL`, which may be below the ceiling if capacity is unavailable. The recipe must divide its own work. Shards aggregate into one GitHub context per recipe/platform.

## Every run at once: the web service

```sh
odu web                 # serve in this terminal
odu web --background    # explicitly start or reuse a daemon
odu web --upgrade       # replace the existing service, serve here
```

The default address is **http://127.0.0.1:18440**. If a service already exists, bare `web` refuses; open its URL or replace it. Ctrl-C stops a foreground server, not its CI runs.

Foreground `odu web` prints the cache row's operational `info` lines—migration, CA pass, NAR served, refusals—while keeping the host's own narration quiet; [The cache page](cache/#operating-it) lists them.


The board lists runs across repositories. Open a run to inspect nodes, follow logs, select an earlier attempt, retry a failure, or cancel work. CLI and MCP clients use the same run IDs and state.

### The board does everything `odu` does

Every verb a row serves has a control on the board; the CLI stays where a shell is the natural place — a push from CI, `odu run` in a checkout. An admin creates a bucket from the Cache view — with the upstream switch the CLI's `--no-upstream` stands for — mints, lists and revokes its tokens, pins a closure and runs GC without a terminal; an owner opens a people page, sees who is in, and grants or changes a role.

| You want | `odu` | On the board |
| --- | --- | --- |
| start a run, every option | `odu run …` | **New run** — recipes, platforms, host pins, justfile root, hosts file, no-deps, no-strict, no-post, supersede, linger |
| see the pipeline first | `odu dump`, `odu graph` | **New run** → **Preview pipeline** |
| retry, cancel, read a log | `odu rerun`, `odu cancel`, `odu logs` | a run's page |
| machines and holds | `odu hosts`, `odu lease`, `odu release` | **Machines** |
| import or expire history | `odu history import`, `odu history prune` | **Maintenance** (dry run first) |
| require odu's checks | `odu protect` | **Maintenance** → **Apply protection** (admin; dry run first) |
| administer the cache | `odu cache create\|token\|pin\|gc\|stats` | **Cache**, and a bucket's page (admin) — see [the cache docs](cache/#the-cache-view) |
| tokens and sessions | `odu auth token …` | the profile page |
| roles | `odu auth grant`, `odu auth people` | **People** (owner) |

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

What that does, in five sentences. The daemon binds loopback and runs as the `odu` system user, with its state in `/var/lib/odu` at mode 0700 — the cache's signing keys are in there. The root token arrives as a systemd credential and is exported into the unit's environment, never written into the Nix store. nginx serves one virtual host that proxies `/cache/` and `/_odu/v1/` and answers 404 to everything else, so **the board and `/mcp`, which have no authentication in this release, stay off the public internet**. `cache.domain` also sets the origin a bucket publishes, so the URL `odu cache use` prints is the one your clients can reach.

Reach the board over a tailnet or an SSH forward to `127.0.0.1:18440`, then create the bucket and mint a token:

```sh
odu cache create main
odu cache token mint main --write
```

On a client, trust the bucket — the key `create` printed:

```nix
{
  nix.settings = {
    extra-substituters = [ "https://cache.example.com/cache/main" ];
    extra-trusted-public-keys = [ "main-1:<public-key>" ];
  };
}
```

A bucket can also have **a name of its own** — `https://cache.kolu.dev` — served at the root of that name through a Cloudflare Tunnel, with no port opened. That needs a Cloudflare API token (`services.odu.cloudflare.apiTokenFile`) and the name set on the bucket (`cache.bucketDomains` gives it a vhost and a certificate on a module host); [A domain for a bucket](cache/#a-domain-for-a-bucket) has the whole walk. The same tunnel carries `ODU_PUBLIC_ORIGIN`'s host when the token can edit its zone, which is what lets a Funnel retire — and the App's callback then moves with `publicOrigin`.

`ODU_PUBLIC_ORIGIN` is the setting behind that URL: it names the address a bucket is published under when a proxy stands in front, and defaults to what `cache.domain` and `cache.enableACME` imply. The module requires a loopback `listen`, because the daemon has to sit behind a proxy: without `services.odu.github` nothing authenticates a request at all, and with it the session cookie wants TLS. Those are the two shapes — the second is [Server mode](#server-mode).

**Without the module.** A container or any non-systemd host runs the same one process from the environment the module sets, and needs nothing else. `ODU_STATE_DIR` holds everything — the run catalog, the cache, and the daemon's own gate and socket, which is what a read-only `$HOME` otherwise breaks. `ODU_WEB_ORIGIN` is the address it binds, `ODU_PUBLIC_ORIGIN` the one a bucket's URL is published at, and `ODU_ROOT_TOKEN` the administration secret. The cache stores the compressed NARs under `<state>/cache/objects`; disk is those objects plus staging for the largest in-flight NAR, memory is constant per NAR, and a `--no-upstream` bucket also stores the upstream closures it is pushed.


### Upgrading from a store-backed cache

1. **Module deployment:** leave `NixStore` unset — the old objects are the host's `/nix/store`. **Container:** point `ODU_CACHE_STORE` at the old chroot store.
2. Boot starts serving at once; the migration and the CA pass are row-scoped background tasks. Watch `cache.migration.*` and `cache.self_ca.*`.
3. Wait for `cache.migration.complete`.
4. **Module:** delete the abandoned roots under `<state>/cache/gcroots`, then run `nix-collect-garbage`. **Container:** delete the old store directory. Never delete `/nix/store` itself.
5. Rows the old store lacks stay objectless and answer 404 until re-pushed; the completion line names them.

Contract **2.3 remains additive**: `held` answers an empty list and `odu cache push --wait` returns at once, both deprecated and removed in the next major. A 2.x client keeps working; kolu's pinned CI does not need to move with this cache change.


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
odu auth grant srid owner --origin https://odu.example.com
```

After that the root token is spent — a second grant made with it is refused, whatever the role — and every further grant is an owner's, through that owner's own token:

```sh
odu auth login https://odu.example.com        # paste the owner's personal token
odu auth grant alice admin --origin https://odu.example.com   # or People on the board
```

Or from the board: an owner's header has **People**, which lists who is in — every grant, and every login that has ever signed in (signing out does not remove you), with its role — and grants or changes a role from a select. `odu auth people` prints the same list. The row refuses a grant that would leave the daemon with no owner: grant a second owner before stepping down.

That is the root token's only job on a daemon with a door: it is not a principal, and it cannot start a run or read a bucket.

### A token for a machine or an agent

The header's name opens the **profile page**: your sessions and your personal access tokens. Create one — it is shown **once** — and either store it on a machine or hand it to an agent:

```sh
odu auth login https://odu.example.com      # paste the token; it is kept at ~/.config/odu/auth/credentials, mode 0600
odu auth whoami --origin https://odu.example.com
odu cache list --origin https://odu.example.com

# or, for an agent or CI, no login step:
ODU_TOKEN=odu_... odu mcp --origin https://odu.example.com
```

Every `odu` command, and the MCP bridge, send the token as `Authorization: Bearer` on the connection they open. `ODU_TOKEN` wins over a stored credential, so one shell can be somebody else.

Revoking a token on the profile page, signing out, or a session expiring ends every connection that credential opened: nothing further is served on it, the socket itself is closed, and an open board tab meets the sign-in page.

Sessions last 30 days from the sign-in; using one does not extend it. The cache protocol does not change: public buckets are read without an account — and `odu cache use` reads a public bucket's facts from `GET /cache/<bucket>`, so it works before anybody has signed in — while pushes carry a bucket token as before.

### Two instances

One App per odu instance: the callback URL is a single address, and the client secret is the App's. Two servers need two Apps — each owned by the same personal account is fine, and transferring an App to an organisation later keeps its Client ID, so the secret and `ODU_GITHUB_CLIENT_ID` survive the move.

## Daily workflow

```sh
odu run                      # configured platforms, clean commit, GitHub statuses
odu run --no-post            # clean commit, no GitHub writes
odu run --no-strict          # snapshot working tree on every lane, no GitHub writes
odu attach                   # interactive terminal view
odu status -o json
odu wait --run latest -o json
```

`wait` reports an actionable failure before the other jobs settle. Read its `logKey` with `odu logs KEY`; add `-f` to follow. Pages carry `nextOffset`, `eof`, and `open`: keep reading until at EOF and no longer open.

```sh
odu rerun --run latest test   # unchanged inputs: retry a flake
odu cancel --run latest      # explicit cancellation
```

A retry uses a new attempt on a live coordinator or creates a linked replay after finalization. `run --linger` keeps the coordinator available after settlement but is not required for replay. Old records without placement evidence and dirty/live snapshots may be refused.

**A source fix is a new run.** Commit it and run again. Use `--supersede` to cancel a busy checkout's current run and start the replacement. Without it, Odu returns the existing live run.

Before declaring CI green, check the SHA, requested scope, and outstanding GitHub posting debt. A passing subset does not establish that the whole pipeline passed.

### History and GitHub

On the board: **Maintenance** imports and prunes (each a dry run until you untick it) and applies protection, and the History toggle lists every run.

```sh
odu history list --all
odu history show --run latest
odu history import --dry-run
odu history prune --days 30 --dry-run
odu protect --dry-run
odu protect
```

Logs and attempt evidence outlive the checkout and coordinator, until retention removes them. Imported or expired evidence may not be replayable.

Strict runs post `<recipe>@<platform>` commit statuses using `gh` credentials available to the service. `protect` configures the corresponding required checks; inspect its dry run first. A dry run derives contexts without contacting GitHub, so repository/branch may be null.

<span id="coding-agents-mcp"></span>

## Coding agents

Agents can use **CLI or MCP**. Both start the local web service in the background if needed, reuse it otherwise, and act on the same runs you see at **http://127.0.0.1:18440**. No separate `odu web` step is needed. Disconnecting an agent stops its observation, not CI.

Use the [unified Odu skill](https://github.com/juspay/odu/tree/master/skills/odu) for either interface. The workflow is the same:

| Step | Tool | Keep or check |
| --- | --- | --- |
| Start | `run_start` | Absolute checkout, expected SHA, unique request ID; retain run ID and cursor |
| Observe | `run_wait` | Send `after` from the previous cursor; use a bounded deadline |
| Diagnose | `log_read` | Echo the failure's log key; page with `nextOffset` |
| Retry unchanged inputs | `run_retry` | Track the returned effective run and cursor |
| Test a source fix | `run_start` | New commit, new request ID |
| Finish | `run_read` / `run_wait` | SHA, scope, verdict, posting debt |

Reuse the same mutation request ID and input after a lost reply. A conflict means the input changed; an unresolved request requires inspection before any fresh mutation.

### CLI

An agent with shell access can use `odu surface` directly; no MCP configuration is required. Run it through Nix:

```sh
nix run --accept-flake-config github:juspay/odu -- surface --help
nix run --accept-flake-config github:juspay/odu -- surface run_start --input '{"checkout":"/absolute/repo","expectedSha":"COMMIT_SHA","requestId":"ci-1"}' --json
```

Substitute the checkout and commit, then retain the returned run ID and cursor. Using the `odu` shorthand:

```sh
odu surface run_wait --input '{"runId":"RUN_ID","after":"CURSOR","deadlineMs":30000}' --json
odu surface log_read --input '{"key":"LOG_KEY","offset":0}' --json
odu surface run_retry --input '{"runId":"RUN_ID","selector":"test","requestId":"retry-1"}' --json
```

Replace placeholders with the previous responses. `odu run`, `wait`, `logs`, and `rerun` are convenience commands over the same service; use `surface` for the shared structured verb interface.

### MCP

For agents with an MCP client, odu ships the unified skill and its MCP server together as an [Agent Plugin](https://agent-plugins.org/) at the [repository root](https://github.com/juspay/odu). With [agent-distro](https://agent-distro.nixos.asia/#profiles), add it to your profile's `plugins` as `"github:juspay/odu"`. Or configure stdio manually:

```json
{
  "mcpServers": {
    "odu": {
      "command": "nix",
      "args": ["run", "--accept-flake-config", "github:juspay/odu", "--", "mcp"]
    }
  }
}
```

The stdio bridge bootstraps the service and exposes the same verbs as tools (`run_start`, `run_wait`, `log_read`, and so on). HTTP MCP clients can instead connect to **http://127.0.0.1:18440/mcp** once the service is running; an HTTP connection itself cannot start it.

Other shared verbs: `run_list` (the board filtered by checkout, commit and seq, in one call), `run_cancel`, `pipeline_read`, `venue_probe`, `venue_hold`, `venue_release`, `catalog_import`, `catalog_prune` and `protect_apply`. Use `odu surface --help` for their schemas.

**The cache's verbs are a row of their own**, and their names carry its word — `cache_` — then the thing and the act. Every one was renamed when the cache became a surface served beside the runs rather than behind the service, so a script written against odu 1.5 needs this table:

| was | now | takes `rootToken` |
| --- | --- | --- |
| `cache_create` | `cache_bucket_create` | yes |
| `cache_list` | `cache_bucket_list` | yes |
| `cache_describe` | `cache_bucket_describe` | no |
| — | `cache_bucket_paths` | no |
| `cache_tokenMint` | `cache_token_mint` | yes |
| `cache_tokenList` | `cache_token_list` | yes |
| `cache_tokenRevoke` | `cache_token_revoke` | yes |
| `cache_pin` | `cache_pin_create` | yes |
| `cache_gc` | `cache_gc_run` | yes |
| `cache_stats` | `cache_stats_read` | yes |

The same rename reaches argv: `odu surface cache_create …` is `odu surface cache bucket_create …`, because a sibling's commands mount under its key. `odu cache …` — the commands a person actually types — is unchanged. A service started without `$ODU_ROOT_TOKEN` refuses the token-taking verbs with `no_root_token` while the substituter keeps serving; `cache_bucket_describe` and `cache_bucket_paths` take no credential at all, because a bucket's URL, its key and its path list are what it publishes to every client that can read it.

## CLI reference

| Command | Purpose / useful flags | On the board |
| --- | --- | --- |
| `run [recipe[@platform]…]` | `--host P=ADDR`, `--platform P`, `--root NAMEPATH`, `--no-deps`, `--no-post`, `--no-strict`, `--no-snapshot`, `--no-wait`, `--linger`, `--supersede` | **New run** |
| `status`, `attach` | Current checkout's run; `-o json` for machine output | the board's row, a run's page |
| `wait [--run R]` | `--after CURSOR`, `--deadline-ms N`, `--settle`, `--expected-sha SHA`; `--timeout-ms` aliases the deadline | a run's page, live |
| `rerun [--run R] SELECTOR` | `--expect-attempt N`, `--request-id ID` | a node's **Retry** |
| `cancel [--run R] [node\|@platform]` | Whole run by default; `--request-id ID` | a run's, node's or lane's cancel |
| `logs KEY` | `-f`, `--offset B`, `--limit B`; tail with `--offset=-4096` | a node's log pane |
| `history list/show/import/prune` | Durable evidence, import and retention | **History**; **Maintenance** |
| `hosts`, `lease`, `release` | Inspect and manage venue capacity | **Machines** |
| `dump`, `graph` | Inspect the resolved pipeline | **New run** → **Preview pipeline** |
| `protect` | Configure GitHub required checks; preview with `--dry-run` | **Maintenance** → **Apply protection** |
| `cache create/list/use` | Create a bucket, list buckets, print the nix.conf settings for one | **Cache** |
| `cache token mint/list/revoke` | Mint a scoped token (shown once), list tokens, revoke one | a bucket's **Tokens** |
| `cache login <origin>` | Save a token for an origin in `~/.config/odu/cache/credentials` | — (a machine's disk) |
| `cache push <bucket> <path>…` | Upload only what the bucket is missing; talks to the cache directly | — (a build box's job) |
| `cache pin/gc/stats` | Pin a closure, reclaim what retention allows, show sizes and reads | a bucket's **Pin closure**, **Run GC**, **Stats** |
| `auth grant/people` | Set a role; list who is in | **People** |
| `auth token create/list/revoke` | Personal access tokens | the profile page |
| `web`, `surface`, `mcp` | Browser server, generated CLI, agent transport | — |

For `wait`, `rerun`, and `cancel`, omitted `--run` means `latest` in this checkout. Run addresses also accept a run ID or `<sha7>#<seq>`. `odu runs` has been replaced by `history list`.

`wait` exits: **0** passed, **1** failure to act on, **2** still running, **3** owner lost, **4** unknown run, **5** refused. Surface CLI exits: **0** answered (even when CI failed), **1** refused, **2** usage error, **3** unreachable.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| No hosts configured | Add a hosts file or explicitly use `--host SYSTEM=localhost` |
| Dirty checkout refused | Commit changes, or use `--no-strict` to ship a working-tree snapshot |
| Web service already running | Open its URL or use `web --upgrade` |
| Proxied page refused as cross-origin | Set `ODU_WEB_ALLOWED_ORIGINS` to the browser origin when starting/replacing the server |
| Service/build mismatch | Replace the service with the desired Nix build |
| Retry refused | Read the reason; check snapshot, placement evidence and checkout availability |
| CI passed but GitHub is waiting | Inspect posting debt and the service's `gh` credentials |

### Working-tree snapshots

`--no-strict` captures tracked modifications, deletions, modes, symlinks and non-ignored new files into a deterministic Git commit, without staging the user's index, changing HEAD or pushing. All workers and shards run that same `contentSha`. The base remains `sha`; board rows and `run_wait`/`run_read` expose `contentSha` when it differs from the base. Compare both identities when verifying a result. Repeating unchanged edits can reuse the remote object cache; changing content produces a different identity. Each edit needs a new request id.

`--no-snapshot` takes precedence and runs in place on localhost only, including ignored dependencies/build outputs. Non-strict runs never post GitHub statuses, even on clean trees. Finalized working-tree runs cannot be replayed; start a new run. A live retry retains the captured snapshot.

Snapshots always exclude `.ci/` and ignored files. Sparse checkouts and submodule changes are refused. Git clean filters apply; LFS files travel as pointers without remote smudging. Capture fails on any Git error. Bundles include unpushed history and are limited to 64 MiB by `ODU_SNAPSHOT_MAX_BYTES`; an oversized bundle reports its largest overlay paths. A stale prerequisite fetch may require `git fetch --prune origin`.

For transport tests only, set `ODU_SNAPSHOT_TRANSPORT=always` on a private service before starting it: localhost lanes then use origin plus chunked bundles over the real lane stdio surface. This is a test seam, like `ODU_LANE_CONNECT_TIMEOUT_MS`, not a user mode.

Bundle creation and `ODU_SNAPSHOT_MAX_BYTES` apply only when the selected pool may use remote transport. Local-only working-tree runs need no origin and do not pack repository history.
