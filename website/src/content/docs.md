# Docs

Odu runs a `just` CI pipeline across local or remote machines. One local service lets you watch and control every run from a browser, terminal, or coding agent.

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

A remote pool leases one available machine per platform. Builders need SSH access and Nix. Do not mix localhost and remote machines in one pool.

Hosts are read from the first existing file: `$ODU_HOSTS`, `~/.config/odu/hosts.json`, then the legacy `~/.config/justci/hosts.json`. No configured host means a refusal, never an implicit local build. `ODU_CONFIG_DIR` moves odu's whole config directory (hosts.json and cloudflare.json) and disables the fallbacks — for a CI coordinator kept apart from your interactive one (start its service with its own `ODU_WEB_ORIGIN` and `ODU_STATE_DIR` too).

```sh
odu hosts
odu run --platform x86_64-linux
odu run test@aarch64-darwin
```

No SSH builder of your own? See [Run lanes on Cloudflare Containers](#run-lanes-on-cloudflare-containers).

The CLI forwards your shell's `$ODU_HOSTS`. A browser or MCP caller can supply `hostsFile`; omitted uses the service's configuration, while `""` bypasses its override. Retries preserve the parent's recorded inventory choice and host pins.

### Run lanes on Cloudflare Containers

Odu can run `x86_64-linux` lanes in [Cloudflare Containers](https://developers.cloudflare.com/containers/) on your own account. Each container is a Firecracker microVM with 4 vCPU, 12 GiB, an 18 GB root disk and `/dev/kvm`, so NixOS VM tests run there.

1. Use a Cloudflare account on the **Workers Paid** plan, and enable **R2** in the dashboard. R2 holds the lanes' Nix cache.
2. `nix run nixpkgs#wrangler -- login` (or export `CLOUDFLARE_API_TOKEN`).
3. Declare hosts, e.g. in `~/.config/odu/hosts.json`:

   ```json
   { "x86_64-linux": { "host": "cloudflare", "slots": 4 } }
   ```

   Each slot is its own container (`cloudflare:default-0` … `-3`). Named instances work too: `["cloudflare:a", "cloudflare:b"]`.
4. `odu cloudflare setup`. It deploys two Workers with the wrangler odu pins, creates the `odu-lane-cache` bucket and a cache-signing key, and writes `~/.config/odu/cloudflare.json` (mode 0600). Re-run it whenever hosts.json grows, because it sizes `max_instances` from it. Use `ODU_CONFIG_DIR` to keep a CI config apart from your own.
5. Run `odu run` as usual, or pin one run with `--host x86_64-linux=cloudflare`.

**Where work runs.** A run leases **one venue per platform**, and that platform's whole DAG runs in it, because a DAG's nodes share one workspace: `unit` uses the `node_modules` that `install` left. Spreading arbitrary nodes across containers would break that. **Sharding** is how work spreads: an `odu:shard=N` recipe gets N containers, and each re-runs its own dependency closure there. Inside one container, at most **one recipe per vCPU** runs at once (`ODU_RUNNER_MAX_PARALLEL` = 4), and the rest wait their turn. The measurements behind this:

- kolu's whole 20-node DAG started at once on one container, and its e2e hooks timed out on CPU.
- With one recipe per vCPU, a 70-scenario Cucumber shard runs in 2.5–6 minutes per container.

So shard your heavy leaves (e2e suites, VM tests). Up to `max_instances` containers run at once; 22 concurrent containers have been measured. Cloudflare keeps about 7 pre-warmed, which start in 3–8 s, while each container beyond those is provisioned cold in 50–205 s.

**If a lane dies**, whether its transport drops or its venue lease is lost, odu claims a fresh container for that lane alone. A dead primary re-runs its unfinished nodes plus the finished prerequisites they need, since the new container has a fresh workspace. A dead shard lane re-runs its shard's whole dependency closure on a fresh burst slot. The other lanes keep running throughout. Each lane may be re-placed twice before its nodes are errored.

**What a container provides.** Nix, and on the recipe's `PATH` behind it: bash, coreutils, gawk, sed, grep, procps, hostname, findutils, diffutils, which, tar and gzip. Anything else, including fontconfig, browsers and language toolchains, must come from the recipe's `nix develop` shell. `/dev/shm` is a 1777 directory on RAM-backed devfs, which is what Chromium needs. Every lane has **KVM, or it does not start**: the entrypoint makes `/dev/kvm` usable by Nix's build users and exits with an error if it can't, and the Worker re-checks before handing out a lane. A NixOS VM test therefore never silently falls back to QEMU's software emulation. The bridge collects the Nix store whenever free disk bytes or inodes fall under 25%, checking every 10 s. Collection frees only what no running process holds, so nodes whose live closures together outgrow the 18 GB disk need sharding instead.

**The lane cache.** The runner closure is published to the R2 bucket and substituted by every container. The default path reaches the bucket through the Worker's own R2 binding, so it needs no R2 API token. With an R2 API token (Object Read & Write on `odu-lane-cache`), `setup --s3-cache 's3://odu-lane-cache?endpoint=<account-id>.r2.cloudflarestorage.com&region=auto'` uses R2's S3 endpoint directly, with `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` in the environment; that takes the cache traffic off the Worker. Measured cold substitution of the runner: 12.3–12.6 s through the Worker, 7.6–12.4 s over S3. Uploads are signed with a key `setup` generates, and containers trust only that key, cache.nixos.org and odu's own cache.

**GitHub.** From Cloudflare's shared egress, unauthenticated `api.github.com` calls are rate-limited, and that includes unlocked `github:` flake refs. Private repositories also need credentials. `setup --github-token` installs your token (from `GH_TOKEN`, else `gh auth token`) as a Worker secret. Inside each container it becomes Nix's `access-tokens` (`/etc/nix/access-tokens.conf`) and git's credential store (`/root/.git-credentials`), both mode 0600 root. It is never in a recipe's environment or a log. **But CI runs the code under test as root inside that container, so any recipe can read those files.** Use a fine-grained token with *contents: read* on only the repositories CI needs, with a short expiry, never a classic `repo`/`workflow` token. `setup --no-github-token` removes it.

**Cost.** A running container costs about $0.11/h (memory and disk) plus up to $0.29/h of CPU while busy ([pricing](https://developers.cloudflare.com/containers/pricing/)), and stops after 10 idle minutes. `odu hosts` and pool probes never start one. `odu cloudflare status` shows each declared host's state, KVM, free disk and inodes, and the hourly cost right now.

**Upgrades.** There are two Workers:

- **`odu-lane`** holds the routes, the cache and every secret and setting. Re-running setup, rotating a token or changing the cache redeploys only this Worker. Attached lanes ride through: a 15-minute run survived three such changes.
- **`odu-lane-dp`** holds the containers and changes only when odu's container code changes. A new version of it drops lanes attached within the next several minutes: drops were measured at 5 and 7.5 minutes after a deploy. So setup refuses to deploy it while a declared host is running, unless you pass `--force`, and then prints the time after which new runs are safe, 10 minutes after the deploy.

`odu cloudflare teardown` deletes both Workers, their containers, the bucket and the local credentials.

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

A proxy that rewrites Host sends a browser Origin that no longer matches it. Admit that origin when starting the service:

```sh
ODU_WEB_ALLOWED_ORIGINS=https://box.tailnet.ts.net \
  nix run github:juspay/odu -- web --upgrade
```

This replaces the existing service in the foreground. The setting is read at server startup; separate multiple origins with commas. `ODU_WEB_ORIGIN` instead changes the listener's address and service identity.

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

Use the [unified Odu skill](https://github.com/juspay/odu/tree/master/.apm/skills/odu) for either interface. The workflow is the same:

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

For agents with an MCP client, an APM dependency on `juspay/odu` installs the unified skill and launcher. Use its generated harness configuration, or configure stdio manually:

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

Other shared verbs: `run_list` (the board filtered by checkout, commit and seq, in one call), `run_cancel`, `pipeline_read`, `venue_probe`, `venue_hold`, `venue_release`, `catalog_import`, `catalog_prune`, and `protect_apply`. Use `odu surface --help` for their schemas.

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
| `web`, `surface`, `mcp` | Browser server, generated CLI, agent transport |
| `cloudflare setup/status/destroy/teardown` | The odu-lane Workers for `cloudflare[:<instance>]` hosts; setup takes `--github-token`/`--no-github-token`, `--max-instances N`, `--s3-cache URL`, `--no-cache`, `--force` |

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
