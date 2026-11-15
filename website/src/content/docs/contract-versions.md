---
title: Contract versions
description: Which version of each part of odu's service a client reads, when a client is refused, and what each cache and run version added.
section: Reference
order: 2
---

Each part of odu's service versions its own contract. A client and the service must agree on the major version of each part the client reads. This page lists the current versions and what each recent one added.

## When a client is admitted

Each part of the service is a **row**: the host, and the parts named `ci`, `cache`, `auth`, `cloudflare` and `metrics`. The service publishes the host's version and every mounted row's version on its identity.

- A client is admitted when the host's major and the major of every row it reads match its own.
- A row the client does not read is never checked, so a cache change never refuses kolu or `odu ci run`.
- A refusal names the row, the version the service serves and the one the build reads. It also says when a row the client needs is not mounted.
- A minor version adds members. A major version changes something a reader already uses.
- Each version is pinned to a fingerprint of its contract, so a change without a version bump fails odu's tests.

## Current versions

| Row | Contract | Who reads it |
| --- | --- | --- |
| host (control, identity, admission) | 2.5 | every client |
| `ci` (runs) | 2.7 | `odu ci run`, `ci wait`, `ci logs`, MCP, the board, kolu |
| `cache` | 4.9 | `odu cache`, `odu surface cache`, the board |
| `auth` | 2.4 | `odu auth login`, `odu surface auth`, the board in server mode |
| `cloudflare` | 2.4 | `odu surface cloudflare`, the board when there is a tunnel |
| `metrics` | 1.0 | `odu surface metrics`, a Prometheus at `/metrics` |

## `cache` versions

| Version | Change |
| --- | --- |
| 3.0 | Removes the `held` list, its `/held` route and `odu cache push --wait`. |
| 3.1 | Adds a bucket's `store`, `store` on `cache_bucket_create`, and the `stores` resource. |
| 4.0 | Runs retention on `lastWanted`, and drops the last-access field from a path and from `cache_stats_read`. Adds `cache_bucket_retention`, `cache_pin_list`, `cache_pin_delete`, `cache_gc_plan`, and `orphans` on the collection report. `retentionDays` at creation becomes optional, defaulting to 90 days. |
| 4.1 | Adds `readsFrom` on a bucket and on `cache_bucket_describe`, `publicUrl` on a declared store, `migration` on a bucket, and `cache_bucket_migrate`, which moves a bucket's objects between stores. |
| 4.2 | Adds `writesTo` on a bucket (`"store"` for direct uploads, `"odu"` for uploads through the service), and the upload negotiation the push client uses to learn it. |
| 4.3 | Adds `cache_bucket_delete`, which takes a bucket's objects out of its store, then deletes the bucket with its paths, pins and own cache tokens. |
| 4.4 | Adds an optional `retentionDays` to `cache_gc_plan` only, so a dry run can ask what another retention would take. `cache_gc_run` does not take it. |
| 4.5 | Adds `group`, `name`, `sort` and `descending` to `cache_bucket_paths`, so a bucket's paths are grouped by package and ordered over the whole bucket. |
| 4.6 | Adds a cache token's `label`, so the bucket page's **Tokens** says `run <id>` for a cache token odu minted for a run. |
| 4.7 | Adds `run` and `commit` to a path, and to a package's newest version, on `cache_bucket_paths`. |
| 4.8 | Adds `stopped` to the collection report: one sentence, or null, saying why a collection stopped. |
| 4.9 | Adds `keptBy` to a path and a package on `cache_bucket_paths`: `kind` (`pin`, `retention`, `reference`, `nothing`), `pins`, `via` and `until`. |

What each field does is on the page that uses it: [Push](/docs/cache/push/), [Keep and reclaim](/docs/cache/retention/), [Keep a bucket on S3](/docs/cache/s3/) and the [command reference](/docs/cache/reference/).

## `ci` versions

| Version | Change |
| --- | --- |
| 2.5 | Adds a run's `push` (where it pushes, and what it pushed) on the run list and on `run_read` and `run_wait`, and `pushed` on a node. |
| 2.6 | Adds a run's `actor` (who started it: a login, or `@local`) on the run list and on `run_read` and `run_wait`. |
| 2.7 | Adds an optional `branch` to `run_start`, so the service fetches its clone and moves it onto that branch at the commit it is handed. See [Hand the server a new commit](/docs/remote-runs/#hand-the-server-a-new-commit). |
