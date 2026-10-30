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

A lease belongs to the checkout and survives the calling shell. `lease` reports `held`, `already`, or `waiting`; use `hosts` to inspect capacity. Release it when finished.

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

The board lists runs across repositories. Open a run to inspect nodes, follow logs, select an earlier attempt, retry a failure, or cancel work. CLI and MCP clients use the same run IDs and state.

### Access through Tailscale or a proxy

Configure forwarding separately; Odu can keep listening on loopback. The service answers to whatever name it is reached by, so an SSH forward, a Tailscale name, or a proxy that passes the Host header through needs no configuration. Anyone who can reach the forwarded address can control CI.

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

What that does, in five sentences. The daemon binds loopback and runs as the `odu` system user, with its state in `/var/lib/odu` at mode 0700 — the cache's signing keys are in there. That user is added to `nix.settings.trusted-users`, because a cache server imports paths built on other machines and those carry no signature your daemon trusts. The root token arrives as a systemd credential and is exported into the unit's environment, never written into the Nix store. nginx serves one virtual host that proxies `/cache/` and `/_odu/v1/` and answers 404 to everything else, so **the board and `/mcp`, which have no authentication in this release, stay off the public internet**. `cache.domain` also sets the origin a bucket publishes, so the URL `odu cache use` prints is the one your clients can reach.

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

`ODU_PUBLIC_ORIGIN` is the setting behind that URL: it names the address a bucket is published under when a proxy stands in front, and defaults to what `cache.domain` and `cache.enableACME` imply. The module requires a loopback `listen`, because a public board is PR 3's (server mode) answer rather than a flag to flip today.

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

Other shared verbs: `run_list` (the board filtered by checkout, commit and seq, in one call), `run_cancel`, `pipeline_read`, `venue_probe`, `venue_hold`, `venue_release`, `catalog_import`, `catalog_prune`, `protect_apply`, and the cache's `cache_create`, `cache_list`, `cache_describe`, `cache_tokenMint`, `cache_tokenList`, `cache_tokenRevoke`, `cache_pin`, `cache_gc` and `cache_stats`. Use `odu surface --help` for their schemas. Every cache verb but `cache_describe` takes `rootToken`; a service started without `$ODU_ROOT_TOKEN` refuses the rest with `no_root_token` while the substituter keeps serving. `cache_describe` answers a bucket's substituter URL and public key with no credential, which is what `odu cache use` needs.

## CLI reference

| Command | Purpose / useful flags |
| --- | --- |
| `run [recipe[@platform]…]` | `--host P=ADDR`, `--platform P`, `--root NAMEPATH`, `--no-deps`, `--no-post`, `--no-strict`, `--no-snapshot`, `--no-wait`, `--linger`, `--supersede` |
| `status`, `attach` | Current checkout's run; `-o json` for machine output |
| `wait [--run R]` | `--after CURSOR`, `--deadline-ms N`, `--settle`, `--expected-sha SHA`; `--timeout-ms` aliases the deadline |
| `rerun [--run R] SELECTOR` | `--expect-attempt N`, `--request-id ID` |
| `cancel [--run R] [node\|@platform]` | Whole run by default; `--request-id ID` |
| `logs KEY` | `-f`, `--offset B`, `--limit B`; tail with `--offset=-4096` |
| `history list/show/import/prune` | Durable evidence, import and retention |
| `hosts`, `lease`, `release` | Inspect and manage venue capacity |
| `dump`, `graph` | Inspect the resolved pipeline |
| `protect` | Configure GitHub required checks; preview with `--dry-run` |
| `cache create/list/use` | Create a bucket, list buckets, print the nix.conf settings for one |
| `cache token mint/list/revoke` | Mint a scoped token (shown once), list tokens, revoke one |
| `cache login <origin>` | Save a token for an origin in `~/.config/odu/cache/credentials` |
| `cache push <bucket> <path>…` | Upload only what the bucket is missing; talks to the cache directly |
| `cache pin/gc/stats` | Pin a closure, reclaim what retention allows, show sizes and reads |
| `web`, `surface`, `mcp` | Browser server, generated CLI, agent transport |

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
