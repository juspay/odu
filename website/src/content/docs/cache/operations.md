---
title: Operate the cache
description: Where odu keeps the cache's files, how much disk it needs, what to back up, and every line the cache logs.
section: Binary cache
order: 8
---

This page is for whoever runs the server: where the cache's files are, how big they get, what to back up, and what each log line means. To set up a server, see [Self-host on NixOS](/docs/self-host/).

## Where the files are

`<state>` is the first of these that applies. The run history lives there too.

| Where | `<state>` |
| --- | --- |
| `$ODU_STATE_DIR` is set | `$ODU_STATE_DIR` |
| Linux | `$XDG_STATE_HOME/odu`, which is `~/.local/state/odu` by default |
| macOS | `~/Library/Application Support/odu` |
| the NixOS module | `/var/lib/odu` |

```text
<state>/cache/cache.sqlite            metadata, bucket signing keys, token hashes, pins
<state>/cache/objects/<bucket>/       nar/<narHash>.<ext> (immutable), <hash>.narinfo,
                                      nix-cache-info
<state>/cache/staging/                uploads between their NAR and their narinfo
```

- An upload waits in `staging/` until its narinfo arrives. One that never gets it is swept after an hour, so a client killed between the two PUTs cannot leak a NAR.
- On an S3 store, the objects are in the store's bucket instead of `objects/`.
- Cache tokens are stored only as hashes, so a copy of the database cannot push. The signing keys are in it, so treat it as a secret.

### The service's own home

The service's lock and control socket are not under `<state>` by default. Their directory is named for the service's origin: `odu-web` at the default origin, and `odu-web-<hash>` at any other, so two services never share one.

- Without `$ODU_STATE_DIR`, it is `$HOME/.local/state/odu-web*`, beside `odu` rather than inside it.
- It is never under `$XDG_STATE_HOME`, which differs between a login shell, a bare ssh and a systemd unit. Two launches that computed two homes would split one service.
- Set `$ODU_STATE_DIR`, and the home moves inside it. A container with a read-only `$HOME` wants that.

## How much disk and memory

- Disk is the compressed objects, plus staging for the largest NAR being uploaded.
- Memory per NAR is constant, not in proportion to its size.
- A bucket created with `upstreamKeys: []` also stores every upstream-signed closure it is pushed. Budget that disk on purpose.

## What to back up

Back up the database and the objects: `<state>/cache/cache.sqlite`, `objects/`, and each S3 store's bucket. The bytes cannot be rebuilt from anywhere else.

## What the service does at start

The cache serves at once, then does its upkeep in the background:

- It sweeps objects that no path names, such as one left by a crash between upload and record, or by a collection that stopped between two deletes. The sweep knows all three kinds of key, so it never takes a narinfo for an orphan.
- It writes any narinfo object a path lacks, two at a time. An object already there with the right length is skipped, so a restart halfway costs a walk, not a rewrite. When the `nix-cache-info` text changes, such as after a move to a new public origin, it rewrites that object and purges its address at the edge.
- It proves `CA:` once for paths that have not been proved, with two workers, and keeps each verdict. A path that refers to itself is proved by reading its object from the store, and once proved, its narinfo in the store is rewritten with the `CA:` line. An upgrade that adds a way to prove such a path sets every one not proved back to unproved, so the first start after it reads each once.
- It aborts S3 multipart uploads that a killed service left behind.

### The one-time migration

A cache upgraded from the store-backed design has paths with no object. The steps are on [Self-host on NixOS](/docs/self-host/#upgrade-from-a-store-backed-cache). What the service does:

- It copies each path from the old store (`$ODU_CACHE_STORE`, or the host's `/nix/store` when unset) into the object store, two at a time.
- It pauses below 10 GiB free and checks again every minute, resuming without a restart.
- Until a path's object lands, its NAR is served from the old store, logged as `source: transition`.
- A path the old store lacks returns 404 and is named once. A path whose object is missing or unreadable is retried at the next start, not on a request.
- `cache.migration.complete` says every path has its object, and the old store can go. On a module host, delete the abandoned roots under `<state>/cache/gcroots`, then let `nix-collect-garbage` reclaim the paths. Do not delete `/nix/store`.

## Log lines

A service in the foreground (`odu web`) prints these lines, and keeps its other logging quiet.

| Line | Fields | What it means |
| --- | --- | --- |
| `cache.migration.start`, `.progress`, `.pause`, `.resume`, `.complete`, `.incomplete` | objects, NAR bytes, free space | The one-time migration. After `incomplete`, the paths it names have no object and no copy in the old store, and return 404 until pushed again. |
| `cache.migration.object_failed` | `bucket`, `path`, `reason` | One path the migration could not move, such as one the old store does not have, or has with another `NarHash`. |
| `cache.self_ca.start`, `.progress`, `.complete` | paths, bytes, proved, refused, unreadable, skipped | Proves `CA:` for paths that refer to themselves: once per path, and again after an upgrade that adds a way to prove them. `skipped`: paths a push or a collection changed meanwhile. |
| `cache.nar.served` | path, bytes written, ms, `source`, `cancelled` | A NAR served. `source` is `object` from the bucket's store, `transition` from the old Nix store, or `redirect` for a 307 to an S3 store, always with `bytes: 0`. |
| `cache.nar.uploaded` | `bucket`, `file`, `mode`, `parts`, `bytes` | A NAR upload completed, direct or staged, with the bytes odu measured itself. |
| `cache.narinfo.served` | `bucket`, `hash`, `hit` | A narinfo asked of odu, and whether the bucket had it. |
| `cache.nar.unavailable` | path | No object, and the old store lacks it. Served as 404, logged once per path. |
| `cache.boot.orphans`, `cache.boot.ca` | counts | The sweep and the metadata `CA:` counts at start. |
| `cache.import.recorded`, `cache.request.refused`, `cache.object.put_failed` | — | A path recorded, a request refused, an object that could not be written. |
| [`cache.nar.verify_failed`](#cachenarverify_failed) | `bucket`, `path`, `file`, `mode`, `reason` | An upload odu would not vouch for, refused with 400. |
| `cache.gc` | `evicted`, `kept`, `orphans`, `bytes`, `stopped` | One line per collection, scheduled or asked for. `kept` counts paths whose bytes a twin still names. `stopped` appears when the store refused a delete. |
| `cache.gc.purge` | per bucket | How many URLs a collection announced to the edge. |
| `cache.gc.failed` | — | A scheduled collection hit an error. The next one is still scheduled. |
| `cache.narinfo.backfill` | `bucket`, `written`, `remaining` | The start-up pass that writes missing narinfo objects, one line per five hundred paths and one at the end. |
| `cache.narinfo.object_failed` | `bucket`, `path`, `reason` | A narinfo object could not be written. |
| `cache.narinfo.purge` | `bucket`, `urls` | A push rewrote a narinfo object, so its address is announced to the edge. A NAR never is: it is named by its own bytes. |
| `cache.store.public.unreachable` | `store`, `url`, `status` | A store's `publicUrl` did not answer `nix-cache-info` at start. odu keeps serving, but readers sent to that domain fail. |
| `cache.store.endpoint.unreachable` | `store`, `endpoint`, `host` | A store holding a bucket has a loopback or link-local `endpoint`. Clients follow redirects to it, so every NAR read fails on the client. |
| `cache.bucket.exposed` | `bucket`, `store`, `url` | A private bucket is on a store with a public URL, so anyone who knows its name can read it. New ones are refused; this names those already there. |
| `cache.bucket.migrate.start`, `.progress`, `.flipped`, `.done`, `.failed` | `copied`, `total`, `bytes` | A move to another store. |
| `cache.bucket.migrate.purge` | — | The old store's URLs a move asked the edge to drop. |
| `cache.bucket.deleted` | `bucket`, `objects`, `bytes` | A bucket was deleted: the store objects removed under its prefix, and their size. It is the only record left of the bucket. |
| `cache.bucket.delete.purge` | `bucket`, `urls` | The deleted bucket's addresses, announced to the edge. |

### `cache.nar.verify_failed`

The `reason` says why odu refused an upload:

| `reason` | What happened |
| --- | --- |
| `absent` | The narinfo names a NAR nothing uploaded. |
| `unreadable` | The bytes would not decompress, or would not read. |
| `nar_hash_mismatch` | The bytes hash to something else. |
| `unversioned_source`, `source_changed` | The version of the object odu read back could not be pinned, or was gone by the copy. |
| `short_read` | A direct upload's read-back got fewer bytes than promised: a window returned less than its range, or a later window returned `412` or `416`. |

`short_read` is not a verdict on the NAR. Push the path again.
