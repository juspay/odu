---
title: A domain for a bucket
description: Give a bucket a domain of its own, which odu wires through a Cloudflare tunnel with no port opened.
section: Binary cache
order: 6
---

A bucket is served at `https://<your odu>/cache/<bucket>`. Give it a domain of its own, and that is the URL people put in `nix.conf`, and it stays the same when the server moves. odu does the wiring through Cloudflare: you hand it one API token and set the domain.

Commands are written with the [`odu` shorthand](/docs/#quick-start).

## Create the Cloudflare token

In Cloudflare, **My Profile → API Tokens → Create Token → Custom token**:

| Field | Value |
| --- | --- |
| Token name | `odu` |
| Permissions | **Zone → DNS → Edit**, **Zone → Zone → Read**, **Account → Cloudflare Tunnel → Edit** |
| Zone Resources | Include → Specific zone → `kolu.dev` (one line per zone you will use) |
| Account Resources | Include → your account |

## Give it to odu

| Setting | What it holds |
| --- | --- |
| `ODU_CLOUDFLARE_API_TOKEN_FILE` | a file holding the token |
| `services.odu.cloudflare.apiTokenFile` | the same, on NixOS, as a systemd credential |

odu checks the token at start. A missing or inactive token stops the tunnel part of the service from starting, with Cloudflare's own sentence.

## Set the domain

On the bucket's page, type the domain under **Domain** and save it. Or use the API verb:

```sh
odu surface cache bucket_domain --origin https://odu.example.com \
  --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","bucket":"kolu","domain":"cache.kolu.dev"}' --json
```

odu then:

1. creates one Cloudflare tunnel for this server, named after its public origin, the first time any domain is set;
2. routes every domain through that tunnel to the cache;
3. creates each proxied DNS record;
4. starts the `cloudflared` connector as a child of the service.

## Check that it is live

| State | Meaning |
| --- | --- |
| `wiring` | odu is setting it up |
| `live` | `https://<name>/nix-cache-info` answers |
| `failed` | Cloudflare refused, with its reason, such as a token without the DNS permission or a zone the token cannot see |

The bucket's page and the board's **Tunnel** page show the state, and `odu surface cloudflare status_read --json` returns it in a terminal. **Tunnel** also shows the connector: running, connected, stopped, or failed with the last words `cloudflared` said.

Once live, the bucket's **Set up** block and `odu cache use kolu` print the new URL, and the old `/cache/kolu` URL keeps working. Pushes are the same: `odu cache push kolu` finds the bucket by name.

## What the domain serves

- The domain serves only its bucket. `/` is the bucket's public page, and the Nix protocol's paths (`/nix-cache-info`, `/<hash>.narinfo`, `/nar/<file>` and the push routes) are served.
- Everything else on that domain, such as the board, `/mcp`, `/auth` and `/rpc/ws`, returns 404. The tunnel forwards every path, and odu routes by `Host`. The board stays on `cache.domain`.
- For a public bucket on a store with a public URL, readers are sent to `<publicUrl>/<bucket>`, because that address answers when odu does not. The bucket's own domain still works for writes and the `missing` query. See [A public URL for a store](/docs/cache/s3/#a-public-url-for-a-store).
- The connector needs outbound HTTPS from the server and nothing inbound. No port is opened on your network, and your server's address never appears in DNS.

## The server's own address

When the server's own host is in a zone the token can edit, the same tunnel carries it too: the board, `/mcp` and the websocket. A Tailscale Funnel is then not needed, and the GitHub App's callback URL moves to that name, with `publicOrigin`.

## Remove it

Clear the **Domain** field, or send `bucket_domain` with no `domain` (`'{"rootToken":"…","bucket":"kolu"}'`). odu removes the route and the DNS record. The tunnel is this server's and stays, and the connector stops when the last domain goes.

## What a domain does not do

A domain is a name, not a lock. A public bucket is read without a cache token at either address. To limit who reads a bucket, make it private: see [Private buckets](/docs/cache/#private-buckets).
