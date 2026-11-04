# Odu

Live CI for `just` pipelines. Watch every run in a browser, attach from a terminal, or let an agent diagnose failures while other jobs continue.

[Website](https://odu.kolu.dev/) · [Documentation](https://odu.kolu.dev/docs/) · [Agent skill](skills/odu/SKILL.md)

## Start

Nix is the only supported way to run Odu. Tag your pipeline's root recipe:

```just
[metadata("ci")]
default: build test lint
```

From a clean checkout, explicitly select a host:

```sh
nix run github:juspay/odu -- ci run --host x86_64-linux=localhost --no-post
```

Use your Nix system in place of `x86_64-linux`. `--no-post` disables GitHub writes; `--no-strict` snapshots your working tree (uncommitted edits and new files included, ignored files excluded) and ships it to remote lanes, with no GitHub writes. `--no-snapshot` runs in place on localhost only.

Open **http://127.0.0.1:18440**. The command starts the shared service automatically and watches the run. Ctrl-C stops watching; CI continues.

To serve the web app explicitly:

```sh
nix run github:juspay/odu -- web               # foreground
nix run github:juspay/odu -- web --background  # explicit daemon
nix run github:juspay/odu -- web --upgrade     # replace it, serve here
```

## Work with a run

Below, `odu` abbreviates `nix run github:juspay/odu --`. The whole CLI is:

```
odu ci <run|wait|rerun|cancel|logs|history|status|attach|hosts|lease|release|dump|graph|protect>
odu ci history <list|show|import|prune>
odu cache <use|login|push>
odu auth login <origin> [--token T]
odu web [--background] [--upgrade]
odu surface <row> <verb…>
odu mcp
```

```sh
odu ci attach
odu ci wait --run latest -o json
odu ci logs LOG_KEY -f
odu ci rerun --run latest test
odu ci cancel --run latest
odu ci history list --all
```

Retry unchanged inputs to investigate a flake. Commit a source fix and start a new run. Check the final SHA, scope, verdict, and GitHub posting debt before declaring success.

A live retry creates a new attempt; a finalized retry creates a linked replay. `ci run --linger` is supported but is not required for replay.

**The board and the API do everything the CLI does — and more.** The CLI keeps only what is shell-native: the `ci` commands, `cache push`/`login`/`use`, and `auth login`. Cache, people and tunnel administration is the board at **http://127.0.0.1:18440** or the API (`odu surface <row> <verb>`), never the CLI. Every `ci` command above has a control too — a run's page, **New run** (every option, and **Preview pipeline**), **Machines** (`ci hosts`/`ci lease`/`ci release`), **Maintenance** (`ci history import`/`prune`, `ci protect`), the Cache view, and an owner's **People**. The [docs](https://odu.kolu.dev/docs/#the-board-and-the-api-do-everything-the-cli-does) map each command to its control.

## Serve a Nix binary cache

The same service is a Nix substituter: one bucket is one cache with its own
ed25519 key, and the server signs every path on ingest.

```sh
export ODU_ROOT_TOKEN=...            # administration needs it; reads do not
odu surface cache bucket_create --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","name":"main","public":true,"retentionDays":30}' --json
odu cache use main                   # the nix.conf lines, a nixConfig block, netrc
odu surface cache token_mint --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","bucket":"main","scope":"write"}' --json
ODU_CACHE_TOKEN=... odu cache push main ./result
```

The token's plaintext is printed once; save it with `odu cache login`. Check each verb's input schema in `packages/cache/src/surface.ts`.

| What | How | On the board |
| --- | --- | --- |
| Create a bucket; print its substituter URL and public key. `"upstreamKeys": []` takes everything, including upstream-signed closures (more disk); `"store": "r2"` keeps its objects in a declared S3 store | `odu surface cache bucket_create` | Cache → **Create bucket** |
| List buckets, with sizes | `odu surface cache bucket_list` | Cache |
| Print the substituter and key settings, a `nixConfig` block, and the netrc lines | `odu cache use <bucket>` | a bucket's page |
| Scoped, expiring, revocable tokens; the plaintext is shown once | `odu surface cache token_mint\|token_list\|token_revoke` | a bucket's **Tokens** |
| Save a token for an origin in `~/.config/odu/cache/credentials` | `odu cache login <origin>` | — |
| Upload only the paths the bucket is missing; long NARs are chunked. `--cache <substituter>` reads the push origin and the bucket off the cache's own `nix-cache-info`. `--pin NAME` re-points that pin at the closure it landed | `odu cache push <bucket> <path>…`, `odu cache push --cache <substituter> <path>…` | — |
| Give a bucket a DNS name of its own through a Cloudflare tunnel | `odu surface cache bucket_domain` | bucket → **Domain** |
| How long a path outlives the last time anything wanted it, in days | `odu surface cache bucket_retention` | a bucket's **Retention** |
| Move a bucket's objects to another declared store, serving from the old one until the copy is done | `odu surface cache bucket_migrate` | a bucket's **Move to another store** |
| Keep a closure out of garbage collection, see what each pin holds, let one go | `odu surface cache pin_create\|pin_list\|pin_delete` | a bucket's **Pins** |
| Evict what retention expired and nothing references or pins — the daily pass, asked for now | `odu surface cache gc_run` | a bucket's **Run GC** |
| What the next collection would take, without taking it | `odu surface cache gc_plan` | a bucket's **Dry run** |
| Storage and reads | `odu surface cache stats_read` | a bucket's **Stats** |
| The tunnel and the names it carries | `odu surface cloudflare status_read` | **Tunnel** |

**Keep a bucket on R2, any S3, or local disk.** Declare a store (`services.odu.cache.stores.r2 = { endpoint; bucket; region; credentialsFile; }`), create the bucket on it, and it serves exactly like disk — the [cache page](https://odu.kolu.dev/docs/cache/#keep-a-bucket-on-s3) has the details. **Reads leave odu where they can:** a NAR on an S3 store is a 307 to a presigned URL good for ten minutes, and a store that names the domain you bound to it (`publicUrl`) has its public buckets advertised there, so they keep serving while odu is down. **Writes leave odu too:** `odu cache push` asks where a NAR's bytes go and an S3-backed bucket hands it presigned URLs, so the NAR never crosses the daemon — which then reads the object back, verifies it and copies it into place before it signs anything. The bucket row says which as `writesTo`.

**A bucket keeps what nobody wants for 90 days.** Retention counts from `lastWanted` — renewed by a push and by the `missing` query a push asks first, never by a read, because reads are leaving odu and a clock a read wound would make the busiest paths look idle first. A pin holds a closure past that — CI takes one with `pin: ${{ github.ref_name == github.event.repository.default_branch }}` in the push action, under a name derived from the repository, the ref and the system — and the reference closure of anything kept is kept. The row collects every bucket once a day on its own; the bucket page's **Run GC** (`cache gc_run`) is that same collection asked for sooner, and its **Dry run** (`cache gc_plan`) says what it would take before you press it. Retention, pins and collection are the board and the API; the CLI's only word in this is `--pin` on a push.

**Each row versions its own surface.** A client is admitted on the host's major and the majors of the rows it reads, so a cache change never refuses a client that reads only runs. Cache **3.0** removed the deprecated `held` list and `odu cache push --wait`; **3.1** adds a bucket's `store`; **4.0** moves retention onto `lastWanted` and drops the old last-access field a path and `stats.read` used to carry, and adds `bucket.retention`, `pin.list`, `pin.delete` and `gc.plan`; **4.1** adds `readsFrom`, a store's `publicUrl`, a bucket's `migration` and `bucket.migrate`; **4.2** adds `writesTo` — whether a push's bytes go straight into the bucket's store — and the upload negotiation that answers it. A chunked push names its parts as its own (`x-odu-upload`), so concurrent pushers of one path never mix them.

| Row | Contract | Who reads it |
| --- | --- | --- |
| host (control, identity cell, admission) | 2.5 | every client |
| `ci` (runs) | 2.4 | `odu ci run`/`ci wait`/`ci logs`, MCP, the board, kolu |
| `cache` | **4.2** | `odu cache`, `odu surface cache`, the board |
| `auth` | 2.4 | `odu auth login`, `odu surface auth`, the board when there is a door |
| `cloudflare` | 2.4 | `odu surface cloudflare`, the board when there is a tunnel |
| `metrics` (the host's own fragment) | 1.0 | `odu surface metrics`, a Prometheus at `/metrics` |

Odu's own builds are served from its own cache. To pull odu and its runners from
it — and to show a project's own bucket — the flake settings are:

```nix
{
  nixConfig = {
    extra-substituters = [ "https://cache.kolu.dev/kolu-r2" ];
    extra-trusted-public-keys = [ "kolu-r2-1:7KmFrK05rVrnxkyZi9hJGnJJmRCpg87u6MUQIk7nokQ=" ];
  };
}
```

`nix copy --to http://127.0.0.1:18440/cache/main ./result` works with no odu code on
the client. The [cache page](https://odu.kolu.dev/docs/cache/) has the
protocol and the storage model.

## Scrape it

`GET /metrics` is a Prometheus exposition of the whole daemon — the cache row's
hit rates, bytes and storage, the runs' durations, and lane use. It carries a
credential: the root token, or a `metrics` token minted for a scraper and
revocable on its own.

```sh
odu surface metrics token_mint --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","label":"prometheus-pod"}' --json
curl -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:18440/metrics
```

| What | How | Answers |
| --- | --- | --- |
| Mint a scrape credential; the plaintext is shown once | `odu surface metrics token_mint` | the token and its facts |
| Name every one, and when it was last used | `odu surface metrics token_list` | ids, labels, `lastUsed` |
| End one immediately, with no restart | `odu surface metrics token_revoke` | the id, revoked |

Counters (`odu_cache_requests_total`, `odu_cache_bytes_total`,
`odu_cache_uploads_total`, `odu_cache_gc_*`) are process-local and reset when the
daemon restarts; gauges (`odu_cache_paths`, `odu_cache_bytes`, `odu_cache_pins`,
`odu_cache_hits_total`) are read from storage at the scrape and do not.
`odu_runs_total`, `odu_run_duration_seconds` and `odu_node_duration_seconds` come
from the on-disk catalog, `odu_lane_reachable`/`odu_lane_held` from the last
venue probe. Behind the NixOS module the route is proxied beside `/cache/`.

## Agents and remote access

The [unified skill](skills/odu/SKILL.md) and its MCP server ship together as an [Agent Plugin](https://agent-plugins.org/) at the repository root. With [agent-distro](https://agent-distro.nixos.asia/#profiles), add `"github:juspay/odu"` to your profile's `plugins`. Or configure a stdio MCP server running:

```sh
nix run --accept-flake-config github:juspay/odu -- mcp
```

MCP, `odu surface`, and the browser use the same local service. The agent loop is `run_start` → `run_wait` → `log_read` → `run_retry` or a new-SHA `run_start`. `run_list` finds run ids by checkout, commit and seq in one call.

The listener stays on loopback. An SSH forward, a Tailscale name or a proxy that keeps the Host header works with no configuration: the service answers to whatever name it is reached by. In the loopback shape anyone who can reach that name can control CI; configure a GitHub App — [server mode](https://odu.kolu.dev/docs/#server-mode) — and they meet a sign-in page, with roles deciding what they may do. Only a proxy that rewrites Host needs its browser origin admitted with `ODU_WEB_ALLOWED_ORIGINS`. See the [access guide](https://odu.kolu.dev/docs/#access-through-tailscale-or-a-proxy).

## Develop

```sh
just install
just typecheck
just test
just e2e         # e2e-cli + e2e-web
nix run . -- web
```

Both e2e suites exercise the Nix-built application: Bun drives CLI/MCP/lifecycle tests; Cucumber + Playwright drives the browser. Both are required on Linux and Darwin.

See [package architecture](packages/), [CLI e2e tests](tests/e2e/README.md), and [browser e2e tests](packages/web-acceptance/README.md).

Working-tree results carry `contentSha` on board rows and `run_wait`/`run_read` answers; compare it as well as the base `sha`. Each edit is a new intent and needs a new request id. Snapshots exclude `.ci/`, refuse sparse checkouts and submodule changes, and apply Git clean filters (LFS files travel as pointers). Bundles are limited to 64 MiB (`ODU_SNAPSHOT_MAX_BYTES`); ignored dependencies and build outputs are recreated by recipes. Finalized working-tree runs require a new run; live retries keep the same snapshot.

Bundle creation and `ODU_SNAPSHOT_MAX_BYTES` apply only when the selected pool may use remote transport. Local-only working-tree runs need no origin and do not pack repository history.
