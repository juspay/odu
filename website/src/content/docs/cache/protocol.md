---
title: Protocol
description: The HTTP routes an odu bucket serves, how it authenticates, how uploads are negotiated, and the lines its nix-cache-info adds.
section: Binary cache
order: 9
---

One bucket is one Nix substituter. This page lists its routes for anyone writing a client, and the two lines its `nix-cache-info` adds for odu's own tools.

## Routes

Point any Nix-compatible tool at these routes:

```text
GET  /cache/<bucket>/nix-cache-info             StoreDir, WantMassQuery: 1, Priority: 41
HEAD /cache/<bucket>/<hash>.narinfo
GET  /cache/<bucket>/<hash>.narinfo
GET  /cache/<bucket>/nar/<narHash>.<ext>       the object: streamed from a disk store with
                                               Content-Length + Range, or 307 to the S3 store
PUT  /cache/<bucket>/nar/<narHash>.<ext>         Bearer or Basic; any ext Nix sends
POST /cache/<bucket>/nar/<file>/upload          where do this NAR's bytes go?
GET  …/nar/<file>/upload/<id>/parts/<i>         a presigned PUT for one part
POST …/nar/<file>/upload/<id>/complete          join the parts, confirm the object
PUT  /cache/<bucket>/<hash>.narinfo             server re-signs with the bucket key
POST /_odu/v1/buckets/<bucket>/missing          batch "which of these are you missing"
POST /_odu/v1/buckets/<bucket>/pin              name a closure a WRITE token keeps
GET  /cache/<bucket>/                           a public bucket's facts: the use block,
                                                or JSON on Accept: application/json
```

| Route group | What to know |
| --- | --- |
| [Reads](#reads) | `nix-cache-info`, narinfos and NARs, from odu or from the store |
| [Authentication](#authentication) | Bearer or Basic, for writes and private reads |
| [`missing`](#missing) | which paths to send |
| [Uploads](#uploads) | the plain PUT, or the three `upload` routes |
| [`pin`](#pin) | a pin a write cache token may make |

### Reads

- A NAR on an S3 store is a 307 to a presigned URL good for ten minutes, and the client re-sends its own `Range` there. A disk store streams it from odu. See [Why a NAR is a redirect](/docs/cache/how-it-works/#why-a-nar-is-a-redirect).
- The same three files also sit in the store itself (`<bucket>/nix-cache-info`, `<bucket>/<hash>.narinfo`, `<bucket>/nar/<file>`), so a public bucket can be read from the store's own domain with odu switched off.
- On a bucket's own domain, the same four Nix paths sit at `/`: `/nix-cache-info`, `/<hash>.narinfo`, `/nar/<file>` and their uploads. `Host` names the bucket.
- Every bucket's URL starts with `/cache`. A bucket called `cache` lives at `/cache/cache`. [How the cache works](/docs/cache/how-it-works/#why-every-url-has-cache-in-it) says why.

### Authentication

Writes, and reads of a private bucket, take `Authorization: Bearer <token>`, or HTTP Basic with any username and the cache token as the password. Nix uses Basic, through curl, on every request, uploads included.

### `missing`

The `missing` route backs `odu cache push`. It is not part of the Nix protocol. The body is `{paths: [{path, sigs}], whole?}`, and it returns two lists, so a push can report them apart:

- `missing`: the paths to send.
- `skippedUpstream`: the paths the bucket does not take because an upstream key signed them.

With `whole: true`, an upstream-signed path the bucket lacks is listed under `missing` instead, and `skippedUpstream` is empty. A `whole` that is not `true` or `false` is refused with a 400 and a sentence. Either way, asking renews the paths the bucket already holds.

### Uploads

The three `upload` routes are the upload negotiation of cache 4.2. The client asks where a NAR's bytes go:

| The bucket's store | It returns | What the client does |
| --- | --- | --- |
| S3 | `{mode:"direct", upload, partSize, part}`, with part 0's presigned URL | PUTs each part to the store, asking for each further part's URL one at a time, then completes |
| disk | `{mode:"staged"}` | the plain `PUT …/nar/<file>` above |

- Every byte of a direct upload is a part of one multipart upload, so completing it leaves the key with no writer odu signed for.
- The narinfo PUT still decides. odu reads the uploaded object back out of the store, verifies it and copies it into place before it records anything.
- An origin too old to answer the negotiation is refused by name.
- A chunked upload that sends `x-odu-upload` owns its parts, so two pushers of one path never mix them. One that does not uses the shared part names.

[Direct and staged uploads](/docs/cache/how-it-works/#direct-and-staged-uploads) explains the two modes.

### `pin`

The `pin` route is the one pin verb outside administration, and it takes write scope, not admin. A write cache token can already keep any closure alive by pushing it again, because a stored push renews a path's `lastWanted`. A pin makes that promise once instead of nightly. It reads nothing and deletes nothing.

- Re-pointing a pin releases what it held, so it depends on who made the pin: `createdBy`, which `pin_list` shows.
- A write cache token may re-point a pin a write cache token made, never an admin's. A leaked CI token, or a typo in a workflow's `pin:`, cannot drop `release-1.0`.
- Write cache tokens of one bucket are peers here, as they are in pushing to it.
- Deleting a pin needs an admin.

## The cache describes itself

`nix-cache-info` carries two lines beyond the three a Nix client reads, both from odu and in the copy the store holds:

```text
Odu-Origin: https://odu.example.com
Odu-Bucket: main
```

| Line | What it names |
| --- | --- |
| `Odu-Origin` | the service that takes a push. Never the name the reader arrived on, which may be a store's domain or a CDN that only answers `GET`. |
| `Odu-Bucket` | the bucket that substituter serves |

Nix ignores keys it does not know, so a reader is unaffected. `odu cache push --cache <substituter>` and the [push action](/docs/cache/github-actions/) read them, so a repository holds one fact about its cache instead of three. When the text changes, as after a move to a new public origin, odu rewrites the store's copy at its next start: see [Operate the cache](/docs/cache/operations/#what-the-service-does-at-start).
