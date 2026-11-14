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


### Contract versions

Each row versions its own surface. The daemon publishes the host's version and every mounted row's on its identity cell (`rows`). A client is admitted when the host's major and the major of **every row it reads** match. A row it does not read is never consulted, so a cache change never refuses kolu or `odu ci run`. A refusal names the row, the version the daemon serves and the one the build reads. It also says when a needed row is not mounted.

| Row | Contract | Who reads it |
| --- | --- | --- |
| host (control, identity cell, admission) | 2.5 | every client |
| `ci` (runs) | **2.6** | `odu ci run`/`ci wait`/`ci logs`, MCP, the board, kolu |
| `cache` | **4.9** | `odu cache`, `odu surface cache`, the board |
| `auth` | 2.4 | `odu auth login`, `odu surface auth`, the board when there is a door |
| `cloudflare` | 2.4 | `odu surface cloudflare`, the board when there is a tunnel |
| `metrics` (the host's own fragment) | **1.0** | `odu surface metrics`, a Prometheus at `/metrics` |

Cache **3.0** removed the deprecated `held` list, its `/held` route and `odu cache push --wait`; **3.1** adds a bucket's `store`, `store` on `cache_bucket_create`, and the `stores` resource; **4.0** runs retention on `lastWanted` and drops the last-access field a path and `cache_stats_read` used to carry, and adds `cache_bucket_retention`, `cache_pin_list`, `cache_pin_delete`, `cache_gc_plan` and `orphans` on the GC report (`retentionDays` at creation is now optional, defaulting to 90 days); **4.1** adds `readsFrom` on a bucket row and on `cache_bucket_describe`, `publicUrl` on a declared store, `migration` on a bucket row, and `cache_bucket_migrate`, which moves a bucket's objects between stores; **4.2** adds `writesTo` on a bucket row — `"store"` when `odu cache push` uploads straight into the bucket's store through presigned URLs and odu reads the object back to verify it, `"odu"` when the bytes cross the daemon — and the upload negotiation the push client speaks to learn it; **4.3** adds `cache_bucket_delete`, which takes a bucket's objects out of its store and then deletes the bucket with its paths, pins and its own tokens; **4.4** adds an optional `retentionDays` to `cache_gc_plan` alone, so a dry run can ask what another retention would take without writing one — `cache_gc_run` does not take it; **4.5** adds `group`, `name`, `sort` and `descending` to `cache_bucket_paths`, so a bucket is grouped by package and ordered by the row — counted over the whole bucket rather than over whichever page a reader holds. **4.6** adds a token's `label`, so the bucket page's Tokens list says `run <id>` for a credential odu minted for a run; **4.7** adds `run` and `commit` to a path and to a package's newest version on `cache_bucket_paths` — what the push said built it, two opaque strings the cache keeps and never resolves; **4.8** adds `stopped` to the GC report, one plain sentence or null: a collection deletes in batches and deletes a batch's objects before dropping its rows, so a store that refuses a delete stops the run with everything unconfirmed still recorded and asking again carries on; **4.9** adds `keptBy` to a path and to a package on `cache_bucket_paths` — `kind` (`pin`, `retention`, `reference`, `nothing`), the `pins` that hold it, the `via` path whose clock does, and `until` — the collector's own answer to "why is this still here, and when does it go", which names pins to every reader of the path list. Runs **2.5** adds a run's `push` — where it pushes and what it warmed — on a board row and on `run_read`/`run_wait`, and `pushed` on a node; **2.6** adds a run's `actor` — who started it, a login or `local` — on a board row and on `run_read`/`run_wait`. A minor version adds members; a major changes something a reader already uses. Each version is pinned to a fingerprint of its surface, so a change to a surface without a bump fails the tests.


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
