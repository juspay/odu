---
title: How the cache works
description: Why odu's cache keeps the NARs it is sent, signs them itself, sends readers to the store, and answers 404 where you might expect 401.
section: Binary cache
order: 7
---

This page explains why odu's cache behaves as it does: what it keeps, who signs, where a read is served from, and why some answers are what they are. The how-to pages say what to do; this one says why.

## A bucket keeps the NAR it was sent

The cache keeps the compressed NAR a pusher sent, once, and no Nix store of its own. Cachix and Attic work the same way.

- An object is a file named for its content: `<bucket>/nar/<narHash>.<ext>`, where the extension is the stored compression.
- References are names in the narinfo. Nothing is imported, so the service needs no `trusted-users` entry and no Nix store.
- A push decompresses the NAR and hashes it against the narinfo's `NarHash`. Then odu keeps the file and records its sha256 and length as `FileHash:` and `FileSize:`.
- The same `NarHash` and compression keeps the existing file. Twins share one object until garbage collection deletes it with the last path that names it.
- A narinfo whose references are absent is recorded anyway, because references are names, not paths a store must hold first. A `.drv` path, or a reference to one, is refused with 400.
- odu serves the bytes as they arrived. It never re-dumps or re-compresses a path for a reader. `nix copy --to` sends xz by default, and `?compression=zstd` sends zstd.

## The server signs, and proves what it signs

A bucket is one substituter URL and one ed25519 public key. The service generates the keypair and signs each narinfo as it records it, so a pusher never holds a signing key. A client's own signatures are kept beside odu's.

odu never signs a hash a client claimed:

- On a direct upload, odu reads the object back out of the store and verifies its `NarHash`, size and `CA:` before it records the path.
- `CA:` is proved from the object odu holds. odu recomputes Nix's `fixed:r:sha256` store path from the name, the references and the bytes, and serves the line only when the formula reproduces the path.
- A path that refers to itself is proved with Nix's hash modulo self-references, computed while the NAR streams through verification. Nix writes it two ways: up to 2.34 it hashes the bytes with each copy of the path's own hash blanked out, and from 2.35 it also hashes the position of each copy. odu computes both and serves the `CA:` line of the one that reproduces the path.

## Direct and staged uploads

Before it sends a NAR's bytes, a push asks the bucket where they go. The bucket's store answers, and there is no flag to set.

| The bucket's store | Mode | Where the bytes go | `writesTo` on the bucket |
| --- | --- | --- | --- |
| an S3 store | `direct` | The client PUTs them to presigned URLs odu signs. No NAR byte crosses odu. | `"store"` |
| the server's disk | `staged` | Through the service, into staging | `"odu"` |

`odu cache push --output json` says which as `mode`.

- In direct mode every byte goes as a part of one multipart upload, a one-part NAR included. Completing the upload ends every URL odu signed for that key, so nobody can rewrite the object odu then reads back.
- Part 0's URL comes with the answer to "where do they go", so a NAR that fits in one part costs no extra round trip.
- A presigned URL lives ten minutes. A part that misses it starts that path again with a new upload.
- A staged NAR larger than `--part-size` (64 MiB by default) goes in parts, each retried on its own, so a push fits under a proxy's request-size cap. Cloudflare's is 100 MB.
- In direct mode nothing proxies the bytes, so `--part-size` is a floor. A part is the largest of it, the store's own part size and S3's 5 MiB minimum.

## Reads leave odu

The store holds the whole protocol, so odu can send a reader to the store: for a public bucket on a store with a public URL, permanently, and for everything else, for the ten minutes a signature lasts.

What a push writes as objects, beside the path it records in odu's database:

| Object | Written by | `Cache-Control` |
| --- | --- | --- |
| `<bucket>/nar/<narHash>.<ext>` | the push, as the bytes arrived | `public, max-age=31536000, immutable` |
| `<bucket>/<hash>.narinfo` | the push, signed with the bucket's key | `public, max-age=86400` |
| `<bucket>/nix-cache-info` | `bucket_create` | `public, max-age=86400` |

Garbage collection deletes a path's narinfo object with the path. A narinfo nobody can get a NAR for is worse than no narinfo.

## Why a NAR is a redirect

On an S3 store, `GET /cache/<bucket>/nar/<file>` returns **307** with a presigned URL that expires in ten minutes, and no body.

- It is a 307, not a 302, because the method must survive the hop. A HEAD that came back as a GET would hand a client asking "is it there?" a whole NAR.
- It works for a private bucket because odu authorizes the request first, then hands out a URL that carries its own authority. When the store's host differs from odu's, curl drops the `Authorization` header on the redirect, so your cache token never reaches the store.
- `Range` is the client's and the store's. A client re-sends its range to the presigned URL and the store returns the 206, so a resumed download never touches odu.
- The redirect itself is `private, no-store` on every bucket. It holds a signature that expires, and an edge that cached it would hand out a dead URL.
- odu gives up the byte count: `cache.nar.served` says `source: "redirect"` with `bytes: 0`, because there is no body to measure.

A disk store streams the NAR from odu with `Content-Length` and `Range`. Through a Cloudflare tunnel, an object over Cloudflare's 512 MB per-file cache limit is served uncached rather than refused, and a 634 MB NAR pulls through a cold edge. Narinfos and `nix-cache-info` asked of odu are rendered from its database and returned by odu.

## Why a private bucket answers 404

An anonymous read of a private bucket returns 404, not 401. "You need a token" would confirm that the bucket exists, and a private bucket's name must not be discoverable. A cache token that is wrong, revoked, expired or scoped to another bucket gets 403.

## Why the priority is 41

A bucket's `nix-cache-info` says `Priority: 41`, one worse than `cache.nixos.org`'s 40. A bucket that takes everything also holds upstream-signed paths. At an equal priority the client's own substituter order would decide who serves them: this machine's uplink, or the CDN that serves them nearer and for free. Losing the tie takes that decision away from whoever wrote the `nix.conf`.

## Why a read does not renew retention

Retention counts from the last time somebody wanted a path: a push of it, or the `missing` query a push asks first. A read moves the path's read count and nothing else. Most reads go to the store, not to odu, so a clock that reads renewed would make the busiest paths the first to look idle. [Keep and reclaim](/docs/cache/retention/) says what retention does.

## Why every URL has `/cache` in it

The board serves `/assets/<hashed bundle>` on the same origin, so a bucket at the origin's first segment could shadow the board's own JavaScript. `/cache` is a literal for that reason. A bucket called `cache` lives at `/cache/cache`.
