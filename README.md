# Odu

Live CI for `just` pipelines. Watch every run in a browser, attach from a terminal, or let an agent diagnose failures while other jobs continue. The same service is the Nix binary cache your runs push to.

**[Documentation](https://odu.kolu.dev/docs/)** · [Website](https://odu.kolu.dev/) · [Binary cache](https://odu.kolu.dev/docs/cache/) · [Agent skill](skills/odu/SKILL.md)

## Try it

Nix is the only supported way to run Odu. From a repository whose `justfile` tags its pipeline's root recipe with `[metadata("ci")]`:

```sh
nix run github:juspay/odu -- ci run --host x86_64-linux=localhost --no-post
```

Use your Nix system in place of `x86_64-linux`. Open **http://127.0.0.1:18440**: the command starts the service and watches the run. Ctrl-C stops watching; CI continues.

To adopt it — the cache line in `flake.nix`, the tagged recipe, the machines, required checks, agents — read [Use odu from your repository](https://odu.kolu.dev/docs/#use-odu-from-your-repository). [`examples/consumer/`](examples/consumer/) is those files whole.

## Documentation

- [Use odu from your repository](https://odu.kolu.dev/docs/#use-odu-from-your-repository) — the three files, lanes, `ci protect`, what odu promises
- [The web service and the board](https://odu.kolu.dev/docs/#every-run-at-once-the-web-service) — and [access through Tailscale or a proxy](https://odu.kolu.dev/docs/#access-through-tailscale-or-a-proxy)
- [Self-host on NixOS](https://odu.kolu.dev/docs/#self-host-on-nixos), [metrics](https://odu.kolu.dev/docs/#metrics), [contract versions](https://odu.kolu.dev/docs/#contract-versions)
- [Server mode](https://odu.kolu.dev/docs/#server-mode) — GitHub sign-in, roles, tokens, running the server's CI from your shell
- [Daily workflow](https://odu.kolu.dev/docs/#daily-workflow), [CLI reference](https://odu.kolu.dev/docs/#cli-reference), [troubleshooting](https://odu.kolu.dev/docs/#troubleshooting)
- [Coding agents](https://odu.kolu.dev/docs/#coding-agents) — the same verbs over `odu surface` and MCP
- [Nix binary cache](https://odu.kolu.dev/docs/cache/) — buckets, tokens, pushing, retention and pins, S3 stores, the protocol

## Agents

This repository is an [Agent Plugin](https://agent-plugins.org/): the [odu skill](skills/odu/SKILL.md) and its MCP server. With [agent-distro](https://agent-distro.nixos.asia/#profiles), add `"github:juspay/odu"` to your profile's `plugins`; otherwise run `nix run --accept-flake-config github:juspay/odu -- mcp` as a stdio MCP server.

## Develop

```sh
just install
just typecheck
just test
just e2e         # e2e-cli + e2e-web
just web         # serve this checkout's odu
just website     # preview the docs site
```

Both e2e suites exercise the Nix-built application: Bun drives CLI/MCP/lifecycle tests; Cucumber + Playwright drives the browser. Both are required on Linux and Darwin. Odu's own CI is [`ci/mod.just`](ci/mod.just), run by odu.

User docs live in [`website/src/content/`](website/src/content/), not here. See [package architecture](packages/), [CLI e2e tests](tests/e2e/README.md), and [browser e2e tests](packages/web-acceptance/README.md).
