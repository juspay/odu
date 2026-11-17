---
title: Push
description: Push store paths to an odu bucket with odu cache push or plain nix copy, pin what you pushed, and say what built it.
section: Binary cache
order: 1
---

`odu cache push` uploads the paths a bucket is missing, with retries, and records each one as it lands. It talks to the cache directly, so you run it on the machine that holds the paths. Plain `nix copy` works too, with no odu on the client.

Commands are written with the [`odu` shorthand](/docs/#quick-start). An `odu ci run` pushes for you: see [What a run pushes](/docs/your-repository/#what-a-run-pushes).

## Give it a cache token

Save a write cache token for an origin once:

```sh
odu cache login http://127.0.0.1:18440
```

It reads the cache token from stdin, or from `--token <token>`, and writes one entry per origin to `~/.config/odu/cache/credentials` (mode 0600). `odu cache push` takes the first of:

1. `--token-file <path>`
2. `$ODU_CACHE_TOKEN`
3. the saved entry for the bucket's origin

[Tokens](/docs/cache/tokens/) says how to mint one.

## Push to a bucket

In CI, export the secret and name the cache by its substituter URL. This is the block a bucket's **Set up** → **push** tab shows, with the cache token filled in when you mint one there:

```sh
# push — a write token, where the build runs
export ODU_CACHE_TOKEN=<your-write-token>
odu cache push --cache https://odu.example.com/cache/main <paths>
```

`--cache <substituter>` takes the URL already in your `nix.conf`, and reads the push origin and the bucket from that cache's own `nix-cache-info`. A CI job then holds nothing that goes stale when a bucket gains a domain or moves stores.

In a shell where you know both, name the bucket and its origin instead:

```sh
export ODU_CACHE_TOKEN=<your-write-token>
odu cache push main <paths> --origin https://odu.example.com
```

- `--cache` and a named bucket are exclusive.
- A bucket name is resolved against the origin you logged in to. A full `https://<host>/cache/<bucket>` URL, as `odu cache use` prints, also works.
- A cache that does not state its origin and bucket, or does not answer, is refused with a sentence naming the URL.
- `--output json` returns `served`, `substituter`, `mode` and `pinned`.

## Push to the flake's cache

With neither `--cache` nor a bucket, `odu cache push <path>…` pushes to the one odu substituter `./flake.nix`'s `nixConfig` names. Two odu caches there is a refusal.

- It probes that substituter without a cache token, so a private bucket must be named with `--cache`.
- It sends only a credential saved for that origin with `odu cache login`. `--token-file` and `$ODU_CACHE_TOKEN` work for any origin, so they are not sent to a URL the repository named.
- To send your own cache token, name the cache: `odu cache target` prints the URL to pass to `--cache`.

> Naming a cache is trusting it. `--cache` sends your cache token to the substituter you name, then pushes to whatever origin its `nix-cache-info` states. Name only a cache you trust, as you already do in `nix.conf`.

## What it prints

One summary line, then one line per path as the bucket answers:

```text
118 paths in the closure: 6 to push, 108 already here, 4 upstream
✅ /nix/store/…-odu-0.1.0/bin/odu stored
⏳ /nix/store/…-big-output part 3
❌ /nix/store/…-bad-output refused: the upload was truncated or corrupted
```

- A path is recorded as it lands. References are names in the narinfo, so the bucket need not hold them first.
- The exit is non-zero only when a path is refused.
- The bucket keeps the upload as it arrived. Where the bytes go depends on the bucket's store: see [Direct and staged uploads](/docs/cache/how-it-works/#direct-and-staged-uploads).
- A large NAR goes in parts of `--part-size` MiB (64 by default), each retried on its own.

## Pin what you pushed

`--pin NAME` re-points that pin at the closure this push landed, so garbage collection keeps it.

- Nothing is pinned if any path was refused.
- `--output json` reports `pinned: {name, rootPaths}`, or `null` when you asked for no pin.
- A write cache token may pin. It may already keep a closure alive by pushing it again, so pinning grants it nothing new.

[Keep and reclaim](/docs/cache/retention/) says what a pin holds.

## Say what built a path

`--run ID` and `--commit SHA` state what built these paths. The bucket keeps both on every path this push stores, and its page shows the commit, short, and the run as a link to its page.

- Both are opaque strings. The cache never resolves them.
- The first push to state a fact keeps it. A push that states neither leaves what a run stated, so your bare re-push of a path CI stored keeps its origin.
- The two are independent, so the GitHub action states only `--commit`.
- `odu ci run` states both without being asked. A path pushed by hand, with neither, shows neither.

## Push a closure that is fetched from this bucket alone

By default a bucket skips the paths an upstream key signed, because cache.nixos.org already serves them. A client that runs `nix copy --from <bucket> <path>` reads that one cache, and stops at the first path the bucket lacks. For such a client, push with `--whole`:

```sh
odu cache push --cache https://odu.example.com/cache/main --whole <paths>
```

- `--whole` stores every path of the closure the bucket lacks, upstream-signed ones included. The summary then says `skipped-upstream 0`.
- It applies to this push only. The bucket's `upstreamKeys` stay as they are, so a push without the flag still skips those paths.
- If the service is too old to store the whole closure, the push stops before sending anything and says so.
- The upstream paths cost disk in the bucket. Each is stored once, however many closures share it.

## Push with plain Nix

`nix copy --to` works with no odu on the client:

```sh
nix copy --to http://127.0.0.1:18440/cache/main ./result
```

Nix reads credentials only from the file its `netrc-file` setting names (`/etc/nix/netrc` by default), never from `~/.netrc` on its own. Use the netrc lines from [Use it](/docs/cache/#use-it), with a write cache token in place of `<your-read-token>`. `odu cache use` prints a placeholder rather than a cache token, because the block goes into files people read and commit.

In CI, put the cache token in the URL instead of a file. The bucket accepts any username, with the cache token as the password:

```sh
nix copy --to "http://x:$ODU_CACHE_TOKEN@127.0.0.1:18440/cache/main" ./result
```

Plain `nix copy --to` compresses each NAR in memory on the client before it uploads, and asks about one path at a time. It sends xz by default, and `?compression=zstd` sends zstd. Prefer `odu cache push` for large closures.

## Compared with `cachix push` and `attic push`

| | cachix push | attic push | `odu cache push` |
| --- | --- | --- | --- |
| Closure, batched missing query, retries | yes | yes | yes |
| Skips paths cache.nixos.org already has | yes | yes | yes: the bucket drops paths an upstream key signed, `cache.nixos.org-1` by default, or none with `upstreamKeys: []`. `--whole` keeps them for one push. |
| Streams NARs, parallel uploads | yes | yes | yes: `nix store dump-path` through zstd, several paths at a time, retried per path |
| Uploads bypass the server | yes, straight to S3 | no | yes on an S3 store: odu signs the URLs, then reads the object back and verifies it. A disk store takes them through the service. |
| Dedup | per NAR | per chunk | per `NarHash`, per bucket |
| Pushes every build as it happens | `watch-exec`, `watch-store` | `watch-store` | no: a job pushes the closures it names |
| Client signs with its own key | optional | no | no; the server signs |
| Client to install | cachix | attic | odu itself, or nothing: `nix copy` with netrc |

A bucket created with `upstreamKeys: []` also stores upstream closures, which costs disk, for clients that cannot reach cache.nixos.org.
