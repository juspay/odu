---
title: Start here
description: odu runs a just CI pipeline on your own machines, shows every run in a browser, terminal or agent, and serves a Nix binary cache.
section: Start
order: 0
---

odu runs a `just` CI pipeline across local or remote machines. One local service lets you watch and control every run from a browser, a terminal or a coding agent. The same service serves a [Nix binary cache](/docs/cache/).

## Quick start

Nix is the only supported way to run odu. You need a repository whose `justfile` tags one recipe `[metadata("ci")]`.

1. Find your Nix system:

   ```sh
   nix eval --impure --raw --expr builtins.currentSystem
   ```

2. From the repository, run its pipeline on this machine:

   ```sh
   nix run github:juspay/odu -- ci run --host x86_64-linux=localhost --no-post
   ```

   Replace `x86_64-linux` with your system. `--host SYSTEM=localhost` allows CI on your workstation, and `--no-post` keeps it off GitHub.

3. Open **http://127.0.0.1:18440**. The command starts the service, creates a run and watches it. <kbd>Ctrl</kbd> + <kbd>C</kbd> stops watching, and CI continues.

The checkout must be clean. To run uncommitted changes, see [Run uncommitted changes](/docs/daily-workflow/#run-uncommitted-changes).

The examples on these pages use `odu` as shorthand for `nix run github:juspay/odu --`.

**Disk does not grow forever.** A bucket keeps what nobody wants for 90 days by default (`retentionDays` at `cache bucket_create`, and the bucket page's **Retention** afterwards), counted from the last time somebody *wanted* a path — a push of it, or the `missing` query a push asks first. A read never renews that clock, because reads are leaving odu and a clock a read wound would make the busiest paths the first to look idle. The row collects every bucket once a day on its own, and nothing is evicted while retention holds, something retained references it, or a pin holds it; **Dry run** on a bucket page says what the next collection would take, and **dry run retention days** beside it asks that question at a retention of your own (`retentionDays` on `cache_gc_plan`; blank is the bucket's own, `0` is what nothing references and no pin holds). The plan writes nothing, and `cache_gc_run` takes no such field, so an answer the dry run gave can never become a collection by another name. A pin holds a closure by name and a push re-points it (`pin: true` in the push action, `--pin NAME` from a shell), which is how a repository keeps its default branch's closure. [Keep and reclaim](cache/#keep-and-reclaim) has the rest.

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

## Find your page

| You want to | Read |
| --- | --- |
| <span id="use-odu-from-your-repository"></span>set up a repository to run on odu and push to its cache | [Use odu from your repository](/docs/your-repository/) |
| say which machines a run uses | [The machines a run uses](/docs/machines/) |
| <span id="daily-workflow"></span>run, watch, retry and read logs | [Daily workflow](/docs/daily-workflow/) |
| run the server's CI from your own shell | [Run the server's CI from your shell](/docs/remote-runs/) |
| <span id="coding-agents"></span><span id="coding-agents-mcp"></span>let a coding agent run CI, over the CLI or MCP | [Coding agents](/docs/agents/) |
| <span id="troubleshooting"></span>get past a refusal | [Troubleshooting](/docs/troubleshooting/) |
| <span id="every-run-at-once-the-web-service"></span>start the web service and use the board | [The web service and the board](/docs/web-service/) |
| <span id="access-through-tailscale-or-a-proxy"></span>reach the board through Tailscale or a proxy | [Access through Tailscale or a proxy](/docs/web-service/#access-through-tailscale-or-a-proxy) |
| <span id="self-host-on-nixos"></span>run odu on a NixOS server | [Self-host on NixOS](/docs/self-host/) |
| <span id="server-mode"></span>put GitHub sign-in in front of the board | [Server mode](/docs/server-mode/) |
| <span id="metrics"></span>scrape odu with Prometheus | [Metrics](/docs/metrics/) |
| serve a Nix binary cache | [Nix binary cache](/docs/cache/) |
| <span id="cli-reference"></span>look up a command, its API verb and its exit codes | [CLI reference](/docs/cli/) |
| <span id="contract-versions"></span>check which versions a client and the service must share | [Contract versions](/docs/contract-versions/) |
