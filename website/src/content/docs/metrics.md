---
title: Metrics
description: Scrape odu's Prometheus metrics with a read-only metrics token, and what each metric counts.
section: Run the service
order: 4
---

`GET /metrics` is a Prometheus text exposition of the whole service. A scrape always carries a credential: the root token, or a read-only metrics token that opens this route and nothing else.

Commands are written with the [`odu` shorthand](/docs/#quick-start).

## Scrape it

Mint a metrics token, then scrape with it:

```sh
odu surface metrics token_mint --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","label":"prometheus-pod"}' --json
curl -H "Authorization: Bearer $METRICS_TOKEN" https://cache.example.com/metrics
```

A metrics token keeps the root token, which administers the server, out of Prometheus.

## Metrics tokens

| API verb | What it does |
| --- | --- |
| `metrics_token_mint` | Mints a metrics token. The plaintext is returned once. |
| `metrics_token_list` | Lists every metrics token, and when each was last used. |
| `metrics_token_revoke` | Ends one at once, with no restart. |

- All three take the root token. A service started without one serves no metrics at all.
- Only a sha256 of each metrics token is kept, in `<state>/metrics/tokens.json`, readable by the owner only.

## What is measured

Each part of the service contributes its own numbers to one exposition.

| Metric | Type | Labels | Counts |
| --- | --- | --- | --- |
| `odu_cache_requests_total` | counter | `bucket`, `kind` (`narinfo`\|`nar`), `outcome` (`hit`\|`miss`\|`redirect`\|`refused`) | requests the cache served |
| `odu_cache_bytes_total` | counter | `bucket`, `direction` (`served`\|`uploaded`), `mode` | NAR bytes served and uploaded |
| `odu_cache_uploads_total` | counter | `bucket`, `mode`, `outcome` (`recorded`\|`failed`) | pushes and imports |
| `odu_cache_gc_evicted_total`, `odu_cache_gc_runs_total` | counter | `bucket` / — | collections |
| `odu_cache_hits` | gauge | `bucket` | `SUM(hits)` over the paths a bucket holds now. A collection lowers it, so it is not a `_total`. |
| `odu_cache_paths`, `odu_cache_bytes`, `odu_cache_pins` | gauge | `bucket` | read from the database at the scrape |
| `odu_cache_last_gc_timestamp_seconds` | gauge | — | the last collection since the service started, `0` when there has been none |
| `odu_runs_total` | counter | `outcome` | runs in the history on disk, each counted once |
| `odu_run_duration_seconds` | histogram | `outcome` | run verdicts, in buckets from 10s to 2h |
| `odu_node_duration_seconds` | histogram | `recipe`, `platform`, `outcome` | each `node_status` entry in a run's journal, counted once |
| `odu_lane_reachable`, `odu_lane_held` | gauge | `host`, `platform` / `host` | the last probe of the machines. Absent until something has probed. |
| `odu_metrics_contributor_up` | gauge | `contributor` | `0` when a part of the service failed this scrape. The scrape is still served. |
| `odu_unhandled_total` | counter | `kind` (`rejection`\|`exception`) | errors the service caught and kept serving through. Both labels are present from the first scrape. |

## Counters and restarts

- Counters belong to the process and reset when the service restarts, which `rate()` handles. Numbers that must survive a restart are gauges read from storage.
- A scrape reads at most the 200 newest runs, at most every ten seconds, so it costs the same on a history of ten thousand runs as on two hundred.
- Each run and each journal entry is added once to totals that only grow. A counter read off a sliding window would fall each time a run left it, and a scraper reads a fall as a reset.
- The run totals therefore start from what those 200 runs held when the service started.
