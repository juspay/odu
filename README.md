# Odu

Live CI for `just` pipelines. Watch every run in a browser, attach from a terminal, or let an agent diagnose failures while other jobs continue.

[Website](https://juspay.github.io/odu/) · [Documentation](https://juspay.github.io/odu/docs/) · [Agent skill](skills/odu/SKILL.md)

## Start

Nix is the only supported way to run Odu. Tag your pipeline's root recipe:

```just
[metadata("ci")]
default: build test lint
```

From a clean checkout, explicitly select a host:

```sh
nix run github:juspay/odu -- run --host x86_64-linux=localhost --no-post
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

Below, `odu` abbreviates `nix run github:juspay/odu --`:

```sh
odu attach
odu wait --run latest -o json
odu logs LOG_KEY -f
odu rerun --run latest test
odu cancel --run latest
odu history list --all
```

Retry unchanged inputs to investigate a flake. Commit a source fix and start a new run. Check the final SHA, scope, verdict, and GitHub posting debt before declaring success.

A live retry creates a new attempt; a finalized retry creates a linked replay. `run --linger` is supported but is not required for replay.

## Serve a Nix binary cache

The same service is a Nix substituter: one bucket is one cache with its own
ed25519 key, and the server signs every path on ingest.

```sh
export ODU_ROOT_TOKEN=...            # administration needs it; reads do not
odu cache create main                # prints the substituter and the public key
odu cache use main                   # the nix.conf lines, a nixConfig block, netrc
odu cache token mint main --write    # printed once; save it with `odu cache login`
ODU_CACHE_TOKEN=... odu cache push main ./result
```

| Command | What it does |
| --- | --- |
| `odu cache create <bucket>` | Create a bucket; print its substituter URL and public key. `--no-upstream` takes everything, for a store that is not the builder's |
| `odu cache list` | List buckets, with sizes |
| `odu cache use <bucket>` | Print the substituter and key settings, a `nixConfig` block, and the netrc lines |
| `odu cache token mint\|list\|revoke` | Scoped, expiring, revocable tokens; the plaintext is shown once |
| `odu cache login <origin>` | Save a token for an origin in `~/.config/odu/cache/credentials` |
| `odu cache push <bucket> <path>…` | Upload only the paths the bucket is missing |
| `odu cache pin <bucket> <name> <path>…` | Keep a closure out of garbage collection |
| `odu cache gc [bucket]` | Evict what retention expired and nothing references or pins |
| `odu cache stats` | Storage and reads |

`nix copy --to http://127.0.0.1:18440/cache/main ./result` works with no odu code on
the client. The [cache page](https://juspay.github.io/odu/cache/) has the
protocol and the storage model.

## Agents and remote access

The [unified skill](skills/odu/SKILL.md) and its MCP server ship together as an [Agent Plugin](https://agent-plugins.org/) at the repository root. With [agent-distro](https://agent-distro.nixos.asia/#profiles), add `"github:juspay/odu"` to your profile's `plugins`. Or configure a stdio MCP server running:

```sh
nix run --accept-flake-config github:juspay/odu -- mcp
```

MCP, `odu surface`, and the browser use the same local service. The agent loop is `run_start` → `run_wait` → `log_read` → `run_retry` or a new-SHA `run_start`. `run_list` finds run ids by checkout, commit and seq in one call.

The listener stays on loopback. An SSH forward, a Tailscale name or a proxy that keeps the Host header works with no configuration: the service answers to whatever name it is reached by. Anyone who can reach that name can control CI. Only a proxy that rewrites Host needs its browser origin admitted with `ODU_WEB_ALLOWED_ORIGINS`. See the [access guide](https://juspay.github.io/odu/docs/#access-through-tailscale-or-a-proxy).

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
