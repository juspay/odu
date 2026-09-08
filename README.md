# Odu

Live CI for `just` pipelines. Watch every run in a browser, attach from a terminal, or let an agent diagnose failures while other jobs continue.

[Website](https://juspay.github.io/odu/) · [Documentation](https://juspay.github.io/odu/docs/) · [Agent skill](.apm/skills/odu/SKILL.md)

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

## Agents and remote access

Use the [unified skill](.apm/skills/odu/SKILL.md), or configure a stdio MCP server running:

```sh
nix run --accept-flake-config github:juspay/odu -- mcp
```

MCP, `odu surface`, and the browser use the same local service. The agent loop is `run_start` → `run_wait` → `log_read` → `run_retry` or a new-SHA `run_start`.

For Tailscale or a reverse proxy, configure forwarding separately and admit its full browser origin when starting the service:

```sh
ODU_WEB_ALLOWED_ORIGINS=http://pureintent.rooster-blues.ts.net:18440 \
  nix run github:juspay/odu -- web --upgrade
```

This replaces the existing server in the foreground. The listener stays on loopback; the setting admits the forwarded Host and Origin for both WebSocket and HTTP MCP. Only admit addresses you trust. See the [access guide](https://juspay.github.io/odu/docs/#access-through-tailscale-or-a-proxy).

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
