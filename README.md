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

**The board does everything `odu` does.** Every command above has a control at **http://127.0.0.1:18440** — a run's page, **New run** (every option, and **Preview pipeline**), **Machines** (`hosts`/`lease`/`release`), **Maintenance** (`history import`/`prune`, `protect`), the Cache view, and an owner's **People**. The [docs](https://odu.kolu.dev/docs/#the-board-does-everything-odu-does) map each command to its control.

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

| Command | What it does | On the board |
| --- | --- | --- |
| `odu cache create <bucket>` | Create a bucket; print its substituter URL and public key. `--no-upstream` takes everything, including upstream-signed closures (more disk) | Cache → **Create bucket** |
| `odu cache list` | List buckets, with sizes | Cache |
| `odu cache use <bucket>` | Print the substituter and key settings, a `nixConfig` block, and the netrc lines | a bucket's page |
| `odu cache token mint\|list\|revoke` | Scoped, expiring, revocable tokens; the plaintext is shown once | a bucket's **Tokens** |
| `odu cache login <origin>` | Save a token for an origin in `~/.config/odu/cache/credentials` | — |
| `odu cache push <bucket> <path>…` | Upload only the paths the bucket is missing; long NARs are chunked | — |
| `odu cache domain <bucket> <name>\|--none` | Give a bucket a DNS name of its own through a Cloudflare tunnel | bucket → **Domain** |
| `odu cache pin <bucket> <name> <path>…` | Keep a closure out of garbage collection | a bucket's **Pin closure** |
| `odu cache gc [bucket]` | Evict what retention expired and nothing references or pins | a bucket's **Run GC** |
| `odu cache stats` | Storage and reads | a bucket's **Stats** |
| `odu cloudflare status` | The tunnel and the names it carries | **Tunnel** |

**Each row versions its own surface.** A client is admitted on the host's major and the majors of the rows it reads, so a cache change never refuses a client that reads only runs. Cache **3.0** removed the deprecated `held` list and `odu cache push --wait`. A chunked push names its parts as its own (`x-odu-upload`), so concurrent pushers of one path never mix them.

| Row | Contract | Who reads it |
| --- | --- | --- |
| host (control, identity cell, admission) | 2.5 | every client |
| `ci` (runs) | 2.4 | `odu run`/`wait`/`logs`, MCP, the board, kolu |
| `cache` | **3.0** | `odu cache`, the board |
| `auth` | 2.4 | `odu auth`, the board when there is a door |
| `cloudflare` | 2.4 | `odu cloudflare`, the board when there is a tunnel |

Odu's own builds are served from its own cache. To pull odu and its runners from
it — and to show a project's own bucket — the flake settings are:

```nix
{
  nixConfig = {
    extra-substituters = [ "https://cache.kolu.dev" ];
    extra-trusted-public-keys = [ "kolu-1:eAXwD1RPt1BpFjrHfVUO8Ia0bK32WcuIeJcwFWmgj9Y=" ];
  };
}
```

`nix copy --to http://127.0.0.1:18440/cache/main ./result` works with no odu code on
the client. The [cache page](https://odu.kolu.dev/docs/cache/) has the
protocol and the storage model.

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
