---
title: The web service and the board
description: Start odu's web service, use the board to watch and control every run, and reach it through Tailscale or a proxy.
section: Run the service
order: 1
---

`odu web` is the one service behind everything: it runs CI, serves the board, answers the CLI and agents, and serves the cache. The CLI and agents start it when it is not running. Start it yourself to keep it in a terminal, replace it, or change how it is reached.

Commands are written with the [`odu` shorthand](/docs/#quick-start).

## Start the service

```sh
odu web                 # serve in this terminal
odu web --background    # explicitly start or reuse a daemon
odu web --upgrade       # replace the existing service, serve here
```

The default address is **http://127.0.0.1:18440**.

- If a service is already running, a bare `odu web` refuses. Open its URL, or replace it with `--upgrade`.
- <kbd>Ctrl</kbd> + <kbd>C</kbd> stops a service in the foreground, not its CI runs.
- A service in the foreground prints the cache's operational lines (migration, the `CA:` pass, NARs served, refusals) and keeps its other logging quiet. [Operate the cache](/docs/cache/operations/#log-lines) lists them.

## Use the board

The board lists runs across repositories. Open a run to inspect its nodes, follow logs, pick an earlier attempt, retry a failure or cancel work. The CLI and agents use the same run IDs and see the same state.

The board does everything the CLI does, and more:

| On the board | What you do there |
| --- | --- |
| **Runs**, **New run**, a run's page | start, watch, retry and cancel runs |
| **Machines** | probe the machines, and hold one |
| **Maintenance** | import and prune history, and require odu's checks on a branch (an admin) |
| **Cache**, a bucket's page | read every bucket. An admin also creates a bucket, mints and revokes cache tokens, sets retention, pins and unpins, reads the dry run and runs garbage collection. |
| **People** | see who is in, and grant or change a role (an owner) |
| **Tunnel** | see the Cloudflare tunnel and its names |

Anything the board does, `odu surface <row> <verb> --input '{…}' --json` does from a shell. The [CLI reference](/docs/cli/) maps each control to its API verb.

The board shows a control only to a role that may use it, and the service checks the role again on its own, so a hidden button is never the only check. A required field left empty is refused when you click, with the reason.

## Access through Tailscale or a proxy

Set up the forwarding yourself. odu can keep listening on loopback, and it answers to whatever name it is reached by. An SSH forward, a Tailscale name, or a proxy that passes the `Host` header through needs no odu configuration.

> Without sign-in, anyone who can reach the forwarded address can control CI. Configure [Server mode](/docs/server-mode/), and they meet a sign-in page instead.

A proxy that rewrites `Host` sends a browser `Origin` that does not match the new `Host`. Admit that origin when you start the service:

```sh
ODU_WEB_ALLOWED_ORIGINS=https://box.tailnet.ts.net \
  nix run github:juspay/odu -- web --upgrade
```

This replaces the running service with one in the foreground. The setting is read when the service starts, and takes several origins separated by commas. On NixOS it is `services.odu.allowedOrigins`.

| Variable | What it sets |
| --- | --- |
| `ODU_WEB_ALLOWED_ORIGINS` | browser origins the service accepts besides its own |
| `ODU_WEB_ORIGIN` | the address the service listens on, which is also its identity |
| `ODU_PUBLIC_ORIGIN` | the address a bucket is published under when a proxy stands in front. See [Self-host on NixOS](/docs/self-host/). |
