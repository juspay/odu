# Docs

Odu runs a `just` CI pipeline across local or remote machines. One local service lets you watch and control every run from a browser, terminal, or coding agent. The same service also serves a Nix binary cache; see [the binary cache docs](cache/).

## Quick start

**Nix is the only supported way to run Odu.** From a repository with a CI-tagged `justfile`:

```sh
nix run github:juspay/odu -- ci run --host x86_64-linux=localhost --no-post
```

Replace `x86_64-linux` with your Nix system (`nix eval --impure --raw --expr builtins.currentSystem`). This explicitly allows CI on your workstation. The checkout must be clean; `--no-strict` snapshots uncommitted edits and new files for local and remote lanes, excludes ignored files, and never posts to GitHub. Use `--no-snapshot` for in-place localhost runs.

Open **http://127.0.0.1:18440**. The command starts the shared service automatically, creates a run, and watches it. Ctrl-C stops watching; CI continues.

Examples below use `odu` as shorthand for `nix run github:juspay/odu --`.

## Use odu from your repository

Your repository declares **one URL**: the Nix cache it reads from. From that:

- `odu ci run` runs your `just` pipeline on the lane machines, posts one GitHub status per recipe and platform, and **pushes what every recipe built to that cache**. No push step, no token in your repository.
- Every developer and every CI machine substitutes from that cache. The paths your default branch built stay there; everything else ages out.
- The board shows each run, each node's log, and — on the bucket — which run and commit built a path.
- Agents reach the same run verbs over MCP.

Three files carry the whole declaration: `flake.nix`, `justfile`, and, if you have a system odu has no lane for, one GitHub workflow. Those three — and the `plugin.json` of section 6 — are shown whole in [`examples/consumer/`](https://github.com/juspay/odu/tree/master/examples/consumer); the snippets below are excerpts of them.

### 1. Declare the cache once

```nix
# flake.nix
nixConfig = {
  extra-substituters = "https://cache.example.com/main";
  extra-trusted-public-keys = "main-1:7KmFrK05rVrnxkyZi9hJGnJJmRCpg87u6MUQIk7nokQ=";
};
```

Both lines come from the bucket's page on the board (**Use this bucket**), or from `odu cache use main`. This is the same `nixConfig` a reader of your flake already needs, so it is not an odu setting — it is the fact odu reads.

Rules odu applies to it:

- The substituter must be a bucket **your** odu serves. A URL it does not serve is left alone: the run still runs, and its page says `not pushing`.
- Name **one** odu cache. Two is refused at start, because a repository builds for one cache.
- The key you list must be the bucket's current key, else the run warns.
- A private bucket works the same way. Reading it needs a token in each reader's netrc (`odu cache use` prints the lines); pushing from a run needs nothing from you.

### 2. Tag the pipeline

```just
[metadata("ci")]
default: build test lint docs e2e
```

The tagged recipe's dependency graph is the pipeline. odu runs each leaf with `just --no-deps`, in dependency order, fanning platforms out to the lanes. Everything else about `just` keeps working:

| You write | odu does |
| --- | --- |
| `[linux]` / `[macos]` on a recipe | Schedules it on that platform only, and drops the edges it cannot honour. `odu ci protect` requires the same filtered set. Mind what `just` does first: it HIDES an OS-mismatched recipe from the machine that reads the file, so a `[linux]` recipe the root depends on makes `just --dump` refuse your justfile on a Mac. Wear one only where the coordinator runs on a platform the attribute admits; otherwise check the OS inside the recipe. (`examples/consumer/` wears none for this reason.) |
| `[metadata("odu:shard=4")]` on a leaf | Runs up to four copies with `ODU_SHARD_INDEX` (0-based) and `ODU_SHARD_TOTAL` (actual), one GitHub context for all of them. |
| `[metadata("odu:pin=<ref>")]` on a recipe | Pins that recipe's closure in the cache under `<owner>/<repo>@<ref>/<system>` — the attribute names the ref whose runs pin, e.g. `odu:pin=main` — so it outlives retention. Put it on the recipes whose outputs your default branch must always serve. A run on another ref pushes and pins nothing; one on no ref at all says a line on its `_ci-setup` node why; a recipe that had a path refused is not pinned. |
| `nix build … --out-link result-foo` inside a recipe | **The out-link is the push.** When a recipe exits 0, every `result*` in the directory it ran in is pushed, closure and all. A recipe that leaves none pushes nothing. |

A recipe that builds but wants nothing pushed simply leaves no `result*` behind. A push that fails makes the node red: green means warmed.

Only a **leaf** may shard, and the recipe divides its own work:

```just
[metadata("odu:shard=2")]
e2e: build
    just test-slice "$((ODU_SHARD_INDEX + 1))/$ODU_SHARD_TOTAL"
```

`ODU_SHARD_TOTAL` may be below the ceiling you asked for when capacity is short, which is why the recipe reads it rather than the number in the attribute.

### 3. Run it

From a clean checkout:

```sh
nix run github:juspay/odu/<rev> -- ci run                   # all platforms the lanes offer
nix run github:juspay/odu/<rev> -- ci run --platform x86_64-linux
nix run github:juspay/odu/<rev> -- ci run test@aarch64-darwin
```

`ci run` starts a run, posts statuses as nodes settle, pushes as recipes finish, and watches. Ctrl-C stops watching; the run continues. The board at the service's origin shows it live.

**Pin the revision.** `github:juspay/odu/<rev>` — a 40-character commit, the same one your push action (below) and your `plugin.json` name. Bump them together. A floating `github:juspay/odu` follows master, and master renames things on a major.

#### The machines it runs on

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
odu ci hosts                    # what each platform has, and who holds it
odu ci lease x86_64-linux       # hold one across several runs
odu ci release x86_64-linux
```

A lease belongs to the **checkout** and survives the calling shell, so release it when you are finished; `lease` reports `held`, `already` or `waiting`. The CLI forwards your shell's `$ODU_HOSTS`. A browser or MCP caller can supply `hostsFile`; omitted uses the service's configuration, while `""` bypasses its override. Retries preserve the parent's recorded inventory choice and host pins.

#### Running the server's checkout

Every `odu ci` command talks to the odu service for the machine you are on unless you name another with `--origin`. To run the **server's** clone of your repository from any shell — no checkout of your own — name the server, hand it a personal token from your profile page, and say which commit:

```sh
export ODU_TOKEN=odu_…
nix run github:juspay/odu/<rev> -- ci run --origin https://odu.example.com \
  --checkout /data/checkouts/<repo> --sha <sha>
```

Other verbs: `ci status`, `ci wait`, `ci attach`, `ci rerun`, `ci cancel`, `ci hosts`, `ci lease`/`ci release`, `ci protect`. Every one is also a control on the board and a verb on the API; nothing is CLI-only.

### 4. When you still need a GitHub workflow

Only when odu has no lane for a system you ship, or you want GitHub Actions' builders for some other reason. The push is **one step**:

```yaml
- uses: juspay/odu/.github/actions/push@<rev>
  with:
    token: ${{ secrets.ODU_CACHE_TOKEN }}
    pin: ${{ github.ref_name == github.event.repository.default_branch }}
```

- **No `cache:`.** The step asks `odu cache target` for the `extra-substituters` line in your `flake.nix` and pushes to that URL by name, with your token. Name `cache:` when the workflow builds for a cache the flake does not list, **or when the bucket is private** — the inference probes anonymously, and a private bucket answers its `nix-cache-info` to nobody, so it cannot be found this way. A flake that names no odu cache, or two, fails the step with the URLs it found.
- **`token`** is a write token for that bucket, minted on the bucket's page (**Tokens → Mint**, scope *write*). A pull request from a fork has no secret and pushes nothing; a push to a branch with no secret fails.
- **`pin`** holds the closure under `<owner>/<repo>@<ref>/<system>`, the same pin a `[metadata("odu:pin=<ref>")]` recipe takes, so a run and a workflow for two systems hold two pins of one name shape.
- It pushes every `result*` in the working directory, or the `paths:` you list. Every path is verified at the substituter afterwards; a path the cache does not answer makes the step red. The results are a table in the step summary. Each row it stores records `$GITHUB_SHA` as the commit that built it — a workflow is nobody's run, so it states no run id.

### 5. Require it

```sh
nix run github:juspay/odu/<rev> -- ci protect            # the default branch
nix run github:juspay/odu/<rev> -- ci protect --dry-run  # print the contexts
```

Sets the branch's required status checks to **exactly** the contexts odu posts — `<recipe>@<system>` for every node the pipeline schedules. Run it after renaming a recipe. A workflow's own contexts (section 4) are yours to add; the board's **Maintenance → Protect** does the same thing from a browser.

### 6. Agents

Put odu in the repository's `plugin.json` — the Agent Plugin file at the repo root that agent-distro reads when any agent (Claude Code, Codex, omp, Pi, OpenCode) is launched in the checkout — and every one of them gets odu's MCP server and skill with no setup:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "<your repo>",
  "extensions": { "asia.nixos.agent-distro": { "plugins": ["github:juspay/odu/<rev>"] } }
}
```

The verbs are the same as the CLI's and the board's: `run_start`, `run_wait`, `run_read`, `log_read`, `run_retry`, `pipeline_read`, `venue_probe`, and the cache's. The odu skill that ships with it tells the agent how to use them.

### 7. What you see afterwards

- **A run's page**: the DAG, each node's log, and a push step per recipe naming the bucket and every path it warmed.
- **A bucket's page**: paths grouped by package, pins by name, what the next collection would take, storage and reads.
- **A path**: the commit it was built from, short, and the run that pushed it, as a link to that run's page — where the push said so. A path somebody pushed by hand says neither. The first builder to state a fact keeps it: odu fills only what a row has not got, never overwriting, so a run can claim a path its own workflow uploaded at the same commit and a later unrelated run changes nothing.
- **GitHub**: one status per `<recipe>@<system>`, linking to the node's log.

### 8. What odu promises you

- **The three files are the whole contract.** `flake.nix` names the cache, `justfile` names the work, and a workflow — if you have one — names a token. Nothing else in your repository mentions odu.
- **Majors rename; minors add.** Within a major, every verb, flag, input and metadata key above keeps working. A client is told, by name, when the server it reaches is a major ahead.
- **A push is verified or red.** Nothing is "pushed" that the cache does not then serve.
- **Your default branch stays substitutable.** Pinned closures are never collected; everything else lives 90 days past the last push (per bucket).
- **Lanes hold no credentials of yours.** The run's token is odu's, scoped to that bucket, dead when the run is.

### 9. What to ask your operator for

The person running odu does these once per repository; nothing here is in your tree.

- A bucket, its write token for your workflow (if any), and the two `nixConfig` lines.
- Your repository linked to the org that owns the bucket, so runs of it may push there.
- Your checkout handed to the server, until odu keeps its own clones.
- The lanes trusting the bucket's key — the same two lines, on their side.

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

| You want | CLI | API verb | On the board |
| --- | --- | --- | --- |
| start a run, every option | `odu ci run …` | `run_start` | **New run** — recipes, platforms, host pins, justfile root, hosts file, no-deps, no-strict, no-post, supersede, linger. `--checkout ABS --sha SHA` names a checkout on a service you name, instead of the one you are standing in |
| see the pipeline first | `odu ci dump`, `odu ci graph` | `pipeline_read` | **New run** → **Preview pipeline** |
| retry, cancel, read a log | `odu ci rerun`, `odu ci cancel`, `odu ci logs` | `run_retry`, `run_cancel`, `log_read` | a run's page |
| machines and holds | `odu ci hosts`, `odu ci lease`, `odu ci release` | `venue_probe`, `venue_hold`, `venue_release` | **Machines** |
| import or expire history | `odu ci history import`, `odu ci history prune` | `catalog_import`, `catalog_prune` | **Maintenance** (dry run first) |
| require odu's checks | `odu ci protect` | `protect_apply` | **Maintenance** → **Apply protection** (admin; dry run first) |
| administer the cache | — | `odu surface cache bucket_create\|bucket_list\|bucket_domain\|bucket_retention\|bucket_migrate\|bucket_delete\|token_mint\|token_list\|token_revoke\|pin_create\|pin_list\|pin_delete\|gc_plan\|gc_run\|stats_read` | **Cache**, and a bucket's page (admin) — **Retention**, **Move to another store**, **Pins**, **Dry run**, **Run GC**, **Delete this bucket**; see [the cache docs](cache/#the-cache-view) |
| tokens and sessions | — | `odu surface auth token_create\|token_list\|token_revoke` | the profile page |
| roles and who you are | — | `odu surface auth user_grant`, `odu surface auth grant_list`, `odu surface auth user_whoami` | **People** (owner) |
| the tunnel and its names | — | `odu surface cloudflare status_read` | **Tunnel** |

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

**A run pushes to the cache its repository already reads from.** That
`extra-substituters` line is the whole declaration: `odu ci run` evaluates the
checkout's `flake.nix` `nixConfig` and pushes every recipe's `result*` closure
to the substituter among them that **this daemon itself advertises** — the
bucket's URL under the daemon's public origin, or a domain bound to it. The
decision is made from the URL against the row's own addresses; nothing a
server says about itself is believed, so a flake pointing at a host somebody
else runs cannot collect a credential for a bucket here. Nothing goes in any
recipe, no token goes in the repository, and the bucket name is never written
twice. The run's write token is minted for that run, scoped to that one
bucket, expires after 24 hours as a backstop and is revoked as soon as nothing
is serving the run — a lingering coordinator keeps it, because a rerun still
pushes. A repository that names a substituter this daemon does not serve is told once,
in `_ci-setup`, and runs as before; one that names two it does serve is
refused at start, because a repository builds for one cache — except on a
REPLAY, which runs without pushing rather than refusing to replay. `run_read`
answers `push`: the bucket and how much landed, or `target: null` and the
reason.

**The push is its own step.** On a run's page each node that pushes grows a
second segment under its bar —
`pushed → <bucket> · N pushed · M present · X MiB · T`, the paths this node
sent told apart from the ones the bucket already had (the `present` clause is
omitted when there were none) — starting where the recipe's bar ends, amber
while the closure is going up and red if it does not land. The node's own
duration stays the RECIPE's. The
push's `[odu] …` lines are a log of their own, not appended to the recipe's:
the page offers **Recipe** and **Push** tabs, and `log_read` takes
`stream: "recipe" | "push"` (absent is the recipe, so every existing caller
reads what it always read) against the same log key. A push that fails makes
the node RED, because green means warmed.

**What a run pushes says where it came from, and may be held.** Every narinfo
a run writes carries the run's id and the commit it was built from, and the
bucket page draws them beside the path — the commit short, the run as a link
to its own page. A recipe marked `[metadata("odu:pin=<ref>")]` additionally
pins its closure under `<owner>/<repo>@<ref>/<system>` on a run that is
actually on that ref, which is the same name the push action derives, so a run
and a workflow never collide and a matrix's two systems never evict each
other. On another ref the run pushes and says nothing; on no ref at all it
says one line on its `_ci-setup` node why nothing was pinned, beside the line
naming where it pushes.

Until organisations land, the bound on all of this is the operator's: there is
no row saying which repository owns which bucket, so any checkout this daemon
runs may push to any bucket it serves. `run.start` only ever reaches a
checkout the operator handed it.

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
| `cache` | **4.7** | `odu cache`, `odu surface cache`, the board |
| `auth` | 2.4 | `odu auth login`, `odu surface auth`, the board when there is a door |
| `cloudflare` | 2.4 | `odu surface cloudflare`, the board when there is a tunnel |
| `metrics` (the host's own fragment) | **1.0** | `odu surface metrics`, a Prometheus at `/metrics` |

Cache **3.0** removed the deprecated `held` list, its `/held` route and `odu cache push --wait`; **3.1** adds a bucket's `store`, `store` on `cache_bucket_create`, and the `stores` resource; **4.0** runs retention on `lastWanted` and drops the last-access field a path and `cache_stats_read` used to carry, and adds `cache_bucket_retention`, `cache_pin_list`, `cache_pin_delete`, `cache_gc_plan` and `orphans` on the GC report (`retentionDays` at creation is now optional, defaulting to 90 days); **4.1** adds `readsFrom` on a bucket row and on `cache_bucket_describe`, `publicUrl` on a declared store, `migration` on a bucket row, and `cache_bucket_migrate`, which moves a bucket's objects between stores; **4.2** adds `writesTo` on a bucket row — `"store"` when `odu cache push` uploads straight into the bucket's store through presigned URLs and odu reads the object back to verify it, `"odu"` when the bytes cross the daemon — and the upload negotiation the push client speaks to learn it; **4.3** adds `cache_bucket_delete`, which takes a bucket's objects out of its store and then deletes the bucket with its paths, pins and its own tokens; **4.4** adds an optional `retentionDays` to `cache_gc_plan` alone, so a dry run can ask what another retention would take without writing one — `cache_gc_run` does not take it; **4.5** adds `group`, `name`, `sort` and `descending` to `cache_bucket_paths`, so a bucket is grouped by package and ordered by the row — counted over the whole bucket rather than over whichever page a reader holds. **4.6** adds a token's `label`, so the bucket page's Tokens list says `run <id>` for a credential odu minted for a run; **4.7** adds `run` and `commit` to a path and to a package's newest version on `cache_bucket_paths` — what the push said built it, two opaque strings the cache keeps and never resolves. Runs **2.5** adds a run's `push` — where it pushes and what it warmed — on a board row and on `run_read`/`run_wait`, and `pushed` on a node; **2.6** adds a run's `actor` — who started it, a login or `local` — on a board row and on `run_read`/`run_wait`. A minor version adds members; a major changes something a reader already uses. Each version is pinned to a fingerprint of its surface, so a change to a surface without a bump fails the tests.


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

### Run the server's CI from your shell

The token above is all a run needs. What a shell must add is WHICH checkout: your cwd is a fact about your laptop, and the server's filesystem is not yours — so name the path on the server, and the commit you believe is there.

```sh
export ODU_TOKEN=odu_… ODU_WEB_ORIGIN=https://odu.example.com
odu ci run --checkout /data/checkouts/kolu --sha "$(git rev-parse HEAD)" --no-post
```

`--sha` is **required** with `--checkout`: it is the strict gate, and a checkout that has moved on is refused rather than quietly run at a different commit. `--checkout` is refused unless a service is **named** (`--origin`, or `ODU_WEB_ORIGIN` as above) — the check is naming, not distance, so an explicit `http://127.0.0.1:18440` is accepted; what is refused is the default, which is the daemon for the directory you are standing in. Without the flags `odu ci run` means this checkout, as it always has.

Your `$ODU_HOSTS` is sent when it names a **path**, `--checkout` included: a face does not decide that your fleet stops applying to your own run, and a path the server has not got is skipped by its resolution chain, which falls through to the server's own `~/.config/odu/hosts.json`. A shell with **no** `$ODU_HOSTS` sends nothing at all for a `--checkout` run — saying "mine is empty" about a world you are not in would blank the server's own variable, and on a pod whose Deployment sets the fleet that is the only inventory there is.

Every run records **who started it** — the token's person, or `@local` on a loopback daemon (a login cannot contain `@`, so the reserved word can never be mistaken for a person). It appears as `started by <login>` on the run's header and in `odu ci history list --all` (`--all`, because such a run's checkout is a path on the server, not yours), and `run_read` answers it as `actor`. It is provenance, not authority: revoking a token stops the next call, not a run already launched.

Revoking a token on the profile page, signing out, or a session expiring ends every connection that credential opened: nothing further is served on it, the socket itself is closed, and an open board tab meets the sign-in page.

Sessions last 30 days from the sign-in; using one does not extend it. The cache protocol does not change: public buckets are read without an account — and `odu cache use` reads a public bucket's facts from `GET /cache/<bucket>`, so it works before anybody has signed in — while pushes carry a bucket token as before.

### Two instances

One App per odu instance: the callback URL is a single address, and the client secret is the App's. Two servers need two Apps — each owned by the same personal account is fine, and transferring an App to an organisation later keeps its Client ID, so the secret and `ODU_GITHUB_CLIENT_ID` survive the move.

## Daily workflow

```sh
odu ci run                      # configured platforms, clean commit, GitHub statuses
odu ci run --no-post            # clean commit, no GitHub writes
odu ci run --no-strict          # snapshot working tree on every lane, no GitHub writes
odu ci attach                   # interactive terminal view
odu ci status -o json
odu ci wait --run latest -o json
```

`ci wait` reports an actionable failure before the other jobs settle. Read its `logKey` with `odu ci logs KEY`; add `-f` to follow. `--stream push` reads the same node's cache push instead of its recipe. Pages carry `nextOffset`, `eof`, and `open`: keep reading until at EOF and no longer open.

```sh
odu ci rerun --run latest test   # unchanged inputs: retry a flake
odu ci cancel --run latest      # explicit cancellation
```

A retry uses a new attempt on a live coordinator or creates a linked replay after finalization. `ci run --linger` keeps the coordinator available after settlement but is not required for replay. Old records without placement evidence and dirty/live snapshots may be refused.

**A source fix is a new run.** Commit it and run again. Use `--supersede` to cancel a busy checkout's current run and start the replacement. Without it, Odu returns the existing live run.

Before declaring CI green, check the SHA, requested scope, and outstanding GitHub posting debt. A passing subset does not establish that the whole pipeline passed.

### History and GitHub

On the board: **Maintenance** imports and prunes (each a dry run until you untick it) and applies protection, and the History toggle lists every run.

```sh
odu ci history list --all
odu ci history show --run latest
odu ci history import --dry-run
odu ci history prune --days 30 --dry-run
odu ci protect --dry-run
odu ci protect
```

Logs and attempt evidence outlive the checkout and coordinator, until retention removes them. Imported or expired evidence may not be replayable.

Strict runs post `<recipe>@<platform>` commit statuses using `gh` credentials available to the service. `ci protect` configures the corresponding required checks; inspect its dry run first. A dry run derives contexts without contacting GitHub, so repository/branch may be null.

<span id="coding-agents-mcp"></span>

## Coding agents

Agents can use **CLI or MCP**. Both start the local web service in the background if needed, reuse it otherwise, and act on the same runs you see at **http://127.0.0.1:18440**. No separate `odu web` step is needed. Disconnecting an agent stops its observation, not CI.

Use the [unified Odu skill](https://github.com/juspay/odu/tree/master/skills/odu) for either interface. The workflow is the same:

| Step | Tool | Keep or check |
| --- | --- | --- |
| Start | `run_start` | Absolute checkout, expected SHA, unique request ID; retain run ID and cursor |
| Observe | `run_wait` | Send `after` from the previous cursor; use a bounded deadline |
| Diagnose | `log_read` | Echo the failure's log key; page with `nextOffset`; `stream: "push"` for a push that failed |
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

Replace placeholders with the previous responses. `odu ci run`, `ci wait`, `ci logs`, and `ci rerun` are convenience commands over the same service; use `surface` for the shared structured verb interface. A sibling row's verbs mount under its key: `odu surface cache …`, `odu surface auth …`, `odu surface cloudflare …`.

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

## CLI reference

The CLI is `ci`, four cache commands, `auth login`, and the three faces of the service:

```
odu ci <run|wait|rerun|cancel|logs|history|status|attach|hosts|lease|release|dump|graph|protect>
odu ci history <list|show|import|prune>
odu cache <use|login|push|target>
odu auth login <origin> [--token T]
odu web [--background] [--upgrade]
odu surface <row> <verb…>
odu mcp
```

| Command | Purpose / useful flags | On the board |
| --- | --- | --- |
| `ci run [recipe[@platform]…]` | `--host P=ADDR`, `--platform P`, `--root NAMEPATH`, `--checkout ABS` with `--sha SHA` (a checkout on the service; needs the service named by `--origin` or `ODU_WEB_ORIGIN`), `--no-deps`, `--no-post`, `--no-strict`, `--no-snapshot`, `--no-wait`, `--linger`, `--supersede`. Pushes every recipe's `result*` closure to the odu cache this repository's `flake.nix` already reads from | **New run** |
| `ci status`, `ci attach` | Current checkout's run; `-o json` for machine output | the board's row, a run's page |
| `ci wait [--run R]` | `--after CURSOR`, `--deadline-ms N`, `--settle`, `--expected-sha SHA`; `--timeout-ms` aliases the deadline | a run's page, live |
| `ci rerun [--run R] SELECTOR` | `--expect-attempt N`, `--request-id ID` | a node's **Retry** |
| `ci cancel [--run R] [node\|@platform]` | Whole run by default; `--request-id ID` | a run's, node's or lane's cancel |
| `ci logs KEY` | `-f`, `--offset B`, `--limit B`; tail with `--offset=-4096` | a node's log pane |
| `ci history list/show/import/prune` | Durable evidence, import and retention | **History**; **Maintenance** |
| `ci hosts`, `ci lease`, `ci release` | Inspect and manage venue capacity | **Machines** |
| `ci dump`, `ci graph` | Inspect the resolved pipeline | **New run** → **Preview pipeline** |
| `ci protect` | Configure GitHub required checks; preview with `--dry-run` | **Maintenance** → **Apply protection** |
| `cache use <bucket>` | Print the nix.conf settings, a `nixConfig` block and netrc for a bucket | **Cache** |
| `cache login <origin>` | Save a token for an origin in `~/.config/odu/cache/credentials` | — (a machine's disk) |
| `cache push <bucket> <path>…`, `cache push --cache <substituter> <path>…`, `cache push <path>…` | Upload only what the bucket is missing; talks to the cache directly. `--cache` reads the push origin and the bucket off that cache's own `nix-cache-info`; with NEITHER a `--cache` nor a bucket, the substituter is read from `./flake.nix`'s `nixConfig`, probed ANONYMOUSLY, and pushed to with only a credential SAVED for that origin (`odu cache login`) — a repository named that URL, so the origin-agnostic `--token-file` and `$ODU_CACHE_TOKEN` stay out of scope for it, and a caller that wants its token sent names the target instead: `odu cache target` prints that URL, and `push --cache <that>` is a named one; a private bucket must be named with `--cache` (two odu caches there is a refusal). `--pin NAME` re-points that pin at the closure it landed. `--run ID` and `--commit SHA` state what built the paths, kept on every row this push stores and drawn on the bucket page; a push that states neither leaves what a run already stated alone | — (a build box's job) |
| `cache target` | Print the one odu substituter `./flake.nix`'s `nixConfig` names, with the same refusals `push` has (no flake, none, two). `-o json` gives `{cache, origin, bucket}`. This is how the push action resolves an omitted `cache:` | — (reads this checkout) |
| `auth login <origin>` | Save a personal access token in `~/.config/odu/auth/credentials` | — (a machine's disk) |
| `web`, `surface`, `mcp` | Browser server, generated CLI, agent transport | — |

Cache, people and tunnel administration is **not** in the CLI: use the board, or `odu surface cache|auth|cloudflare <verb>` — the mapping is in [the board table](#the-board-and-the-api-do-everything-the-cli-does).

For `ci wait`, `ci rerun`, and `ci cancel`, omitted `--run` means `latest` in this checkout. Run addresses also accept a run ID or `<sha7>#<seq>`. `ci history list` lists runs.

`ci wait` exits: **0** passed, **1** failure to act on, **2** still running, **3** owner lost, **4** unknown run, **5** refused. Surface CLI exits: **0** answered (even when CI failed), **1** refused, **2** usage error, **3** unreachable.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| No hosts configured | Add a hosts file or explicitly use `--host SYSTEM=localhost` |
| Dirty checkout refused | Commit changes, or use `--no-strict` to ship a working-tree snapshot |
| Web service already running | Open its URL or use `web --upgrade` |
| Proxied page refused as cross-origin | Set `ODU_WEB_ALLOWED_ORIGINS` to the browser origin when starting/replacing the server |
| Service/build mismatch (`serves the <row> row at …`) | That row moved a major. Run `odu web --upgrade`, or use a build that reads that version |
| Retry refused | Read the reason; check snapshot, placement evidence and checkout availability |
| CI passed but GitHub is waiting | Inspect posting debt and the service's `gh` credentials |

### Working-tree snapshots

`--no-strict` captures tracked modifications, deletions, modes, symlinks and non-ignored new files into a deterministic Git commit, without staging the user's index, changing HEAD or pushing. All workers and shards run that same `contentSha`. The base remains `sha`; board rows and `run_wait`/`run_read` expose `contentSha` when it differs from the base. Compare both identities when verifying a result. Repeating unchanged edits can reuse the remote object cache; changing content produces a different identity. Each edit needs a new request id.

`--no-snapshot` takes precedence and runs in place on localhost only, including ignored dependencies/build outputs. Non-strict runs never post GitHub statuses, even on clean trees. Finalized working-tree runs cannot be replayed; start a new run. A live retry retains the captured snapshot.

Snapshots always exclude `.ci/` and ignored files. Sparse checkouts and submodule changes are refused. Git clean filters apply; LFS files travel as pointers without remote smudging. Capture fails on any Git error. Bundles include unpushed history and are limited to 64 MiB by `ODU_SNAPSHOT_MAX_BYTES`; an oversized bundle reports its largest overlay paths. A stale prerequisite fetch may require `git fetch --prune origin`.

For transport tests only, set `ODU_SNAPSHOT_TRANSPORT=always` on a private service before starting it: localhost lanes then use origin plus chunked bundles over the real lane stdio surface. This is a test seam, like `ODU_LANE_CONNECT_TIMEOUT_MS`, not a user mode.

Bundle creation and `ODU_SNAPSHOT_MAX_BYTES` apply only when the selected pool may use remote transport. Local-only working-tree runs need no origin and do not pack repository history.
