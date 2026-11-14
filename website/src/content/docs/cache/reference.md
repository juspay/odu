---
title: Command reference
description: Every odu cache command, cache API verb and board control, what each does, and the verbs renamed since odu 1.5.
section: Binary cache
order: 10
---

The CLI keeps the four cache commands a shell is the natural place for. Everything else is the board or an API verb, called as `odu surface cache <verb> --input '{…}' --json`, with `rootToken` a field of the input.

Commands are written with the [`odu` shorthand](/docs/#quick-start).

## Commands

| Command | API verb | On the board | What it does |
| --- | --- | --- | --- |
| `odu cache use <bucket>` | `bucket_describe` | a bucket's **Set up** block | Prints the substituter and key settings, the `nixConfig` block and the netrc lines. No account for a public bucket. |
| `odu cache login <origin>` | — | — (a machine's disk) | Saves a cache token for an origin in `~/.config/odu/cache/credentials`. |
| [`odu cache push`](#odu-cache-push) | — | — (a build machine's job) | Uploads only the paths the bucket is missing. |
| `odu cache target` | — | — (reads this checkout) | Prints the one odu substituter `./flake.nix`'s `nixConfig` names, and nothing else. `-o json` gives `{cache, origin, bucket}`. The push action uses it when `cache:` is left out. |

### `odu cache push`

Uploads only the paths the bucket is missing. The bucket keeps what it takes.

```
odu cache push <bucket> <paths…> [--part-size MiB] [--pin NAME] [--run ID] [--commit SHA]
odu cache push --cache <substituter> <paths…>
```

| Flag | What it does |
| --- | --- |
| `--cache <substituter>` | Reads the origin and the bucket from the cache's own `nix-cache-info`, instead of being told them. |
| `--pin NAME` | Re-points that pin at the closure this push landed, unless a path was refused. |
| `--run ID`, `--commit SHA` | State what built the paths. |
| `--part-size MiB` | Sets the size of each part of a large upload. |

The [CLI reference](/docs/cli/#odu-cache-push) has every flag, and [Push](/docs/cache/push/) has how and why.

## API verbs

A service started without `$ODU_ROOT_TOKEN` refuses the verbs that take a `rootToken` with `no_root_token`, and keeps serving the cache. `bucket_describe` and `bucket_paths` take no credential: a bucket's URL, its key and its path list are what it publishes to every client that can read it.

| API verb | On the board | What it does |
| --- | --- | --- |
| [`bucket_create`](#bucket_create) | **Cache** → **New bucket** → **Create bucket** | Creates a bucket. |
| `bucket_list` | **Cache** | Lists buckets. |
| `bucket_describe` | a bucket's page | Returns a bucket's URL, key and where reads are served from. |
| `bucket_paths` | a bucket's **Paths** tab | Lists a bucket's paths, grouped and sorted. See [The board's Cache view](#the-boards-cache-view). |
| `bucket_domain` | a bucket → **Domain** | Gives a bucket a domain of its own, or takes it away when `domain` is omitted. See [A domain for a bucket](/docs/cache/domain/). |
| `bucket_retention` | a bucket → **Retention** | Changes how long a bucket keeps what nobody wants. |
| `bucket_migrate` | a bucket → **Move to another store** → **Start move** | Moves a bucket's objects to another declared store. Returns the bucket, whose `migration` is the progress. It serves from the old store until the copy is done. |
| [`bucket_delete`](#bucket_delete) | a bucket → **Delete this bucket** | Deletes a bucket, its objects first. |
| `token_mint` | a bucket → **Tokens** → **Mint token** (write or read) | Mints a cache token, returned once. `scope` is `read`, `write` or `admin`. |
| `token_list` | a bucket → **Tokens** | Lists cache tokens with scope, expiry and last use. |
| `token_revoke` | a bucket → **Tokens** → **revoke** | Revokes one cache token. |
| `pin_create` | a bucket → **Pins** → **Pin closure** | Pins a closure against garbage collection. A name that exists is re-pointed. |
| `pin_list` | a bucket → **Pins** | Lists what each pin holds, and who made it. |
| `pin_delete` | a bucket → **Pins** → **unpin** | Lets a pin go. |
| [`gc_plan`](#gc_plan) | a bucket → **Dry run**, and the **retention** field beside it | Says what the next collection would take, without taking it. |
| `gc_run` | a bucket → **Run GC** | Evicts paths past retention that nothing refers to and no pin holds: the daily collection, now. |
| `stats_read` | a bucket's facts line | Shows storage and read counts. |

Every verb is typed after `cache`, as in `odu surface cache bucket_create`. Over MCP, each is named with a `cache_` prefix, as in `cache_bucket_create`.

### `bucket_create`

Creates a bucket, and returns its substituter URL, public key and store.

| Field | What it sets |
| --- | --- |
| `name` | the bucket's name |
| `public` | whether it is read without a cache token |
| `retentionDays` | how long it keeps what nobody wants. 90 when absent. |
| `upstreamKeys` | the keys whose paths it skips. `[]` takes everything, including upstream-signed closures, which costs disk, for clients that cannot reach cache.nixos.org. The board's **Skip upstream paths** switched off sends `[]`. |
| `store` | the declared store for its objects. `local` by default. |

### `bucket_delete`

Deletes a bucket: its objects out of its store first, then the bucket, its paths, its pins and the cache tokens scoped to exactly its name. It returns the objects removed and their bytes.

- It is refused while a domain is bound to the bucket, or a move is in flight.
- There is no `odu cache delete`.

[Delete a bucket](/docs/cache/retention/#delete-a-bucket) has the details.

### `gc_plan`

Says what the next collection would take, without taking it. It writes nothing.

- `retentionDays` plans at a retention of your own. Absent is each bucket's own, and `0` asks what nothing refers to and no pin holds.
- `gc_run` has no such field, so a dry run cannot become a collection.
- It takes a `rootToken` like the other administrative verbs, but is marked read-only. An agent may ask what a collection would evict without confirming, and must not run one without.

## The board's Cache view

The board's **Cache** view lists the buckets: name, public or private, how many paths, how much space, the last push, and how many reads. Click one to open its page.

| Part of a bucket's page | What it shows or does |
| --- | --- |
| the facts line | the bucket's numbers and where reads come from: **reads served from cache.example.com** or **reads served by odu**. A push updates it without a reload, and reads are added at most once a second. |
| **Paths** | the paths it serves: **name · hash · size · pushed · reads · commit · run · wanted · kept by**. See below. |
| **Pins** | the pins holding closures: name, system, paths, when, and who made it. Click a name for its roots, ten until you click **show all**. |
| **Set up** | the substituter URL, the public key, and tabs for `nix.conf`, `NixOS`, `flake.nix`, `odu CLI`, `push` and `GitHub Actions` |
| **Root token** | without server mode, asks for the root token once per visit |
| **Tokens**, **Retention**, **Domain** | mint and revoke cache tokens, set retention, set a domain |
| **Move to another store** | shown only when the service declares another store |
| **Garbage collection** | **Run GC**, and **Dry run** with its own **retention** field |
| **Danger zone** → **Delete this bucket** | deletes it, once you type its name |

Anyone may read a bucket's page, which uses `bucket_describe` and `bucket_paths`. The administrative parts are shown to an admin, and the service checks the role again on its own.

### The paths table

- It is grouped by name by default: `odu-base-0.1.0` with six builds is one row with the count, total size, newest push and summed reads. The service counts over the whole bucket, not the rows on screen.
- Click **group by name** for one row per path.
- Click **name**, **size**, **pushed** or **reads** to sort by it, and again to reverse. **Show 20 more** continues in the same order. Inside an open package, **show N more** pages its versions.
- The filter box narrows what the bucket returns.
- A hash shows its first eight characters. Its tooltip is the whole store path, and clicking it copies the path.
- **kept by** says why a path is still here and when it goes: see [Why a path is still here](/docs/cache/retention/#why-a-path-is-still-here).
- The path and pin lists are read when you open them. **refresh paths** and **refresh pins** read them again.

The **Dry run** is taken only when you click it, and again after each collection. The **retention** field beside it changes neither what the bucket keeps nor what **Run GC** evicts.

## Verbs renamed since odu 1.5

A script written against odu 1.5 needs this table. The CLI's own `cache create`, `list`, `token`, `pin`, `gc` and `stats` commands became these API verbs, so `odu surface cache_create …` is now `odu surface cache bucket_create …`. `odu cache push`, `login` and `use` are unchanged.

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

\* `cache_gc_plan` takes a `rootToken`, but is marked read-only: see [`gc_plan`](#gc_plan).
