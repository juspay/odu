> **Status:** ships in the next release; this page is its specification.

# Nix binary cache

`odu web` also serves Nix binary caches. The same loopback service that runs CI answers the standard Nix HTTP binary cache protocol, so every Nix client works unchanged.

A bucket is one cache: one substituter URL under the service's origin and one ed25519 public key. The server generates the keypair and signs each narinfo on ingest; a pusher never holds a signing key. Client signatures are kept. The cache listens on loopback only, like the board.

## Create a bucket

```sh
odu cache create main
```

`create` prints the substituter URL and the bucket's public key. `odu cache use main` prints the same as two Nix settings, ready for `nix.conf`:

```sh
extra-substituters = http://127.0.0.1:18440/main
extra-trusted-public-keys = main-1:<public-key>
```

and as a `nixConfig` block for `flake.nix`:

```nix
{
  nixConfig = {
    extra-substituters = [ "http://127.0.0.1:18440/main" ];
    extra-trusted-public-keys = [ "main-1:<public-key>" ];
  };
}
```

Trust the key, then a build substitutes from the bucket instead of the network. `odu cache use` also prints the two netrc lines described under [Push](#push).

## Tokens

```sh
odu cache token mint main --write
```

The token is printed once and stored hashed. A token carries a bucket glob, a scope (`--read`, `--write` or `--admin`), an expiry, and its last use. Revoke one without touching the rest:

```sh
odu cache token list
odu cache token revoke <id>
```

Administration — creating buckets, minting and revoking tokens, pinning and collecting — needs the root token, which the service reads from `$ODU_ROOT_TOKEN`:

```sh
export ODU_ROOT_TOKEN=...
odu cache create main
```

## Push

Save a write token for an origin once:

```sh
odu cache login http://127.0.0.1:18440
```

That writes one entry per origin to `~/.config/odu/cache/credentials` (mode 0600). `odu cache push` resolves the token in this order:

1. `--token-file <path>`
2. `$ODU_CACHE_TOKEN`
3. the credentials entry for the bucket's origin

The bucket argument is a name resolved against the logged-in origin, or a full `https://<host>/<bucket>` URL. CI exports the secret and never logs in:

```sh
ODU_CACHE_TOKEN=... odu cache push main ./result
```

`push` asks the bucket which paths it is missing, then uploads only those, with retries. It talks to the cache's HTTP API directly, so it runs on the machine that holds the paths.

Prefer plain Nix? `nix copy --to` works without any odu code on the client:

```sh
nix copy --to http://127.0.0.1:18440/main ./result
```

Nix reads credentials only from the file named by its `netrc-file` setting, by default `/etc/nix/netrc` — never `~/.netrc`. `odu cache use main` prints that line and the credential line together:

```sh
netrc-file = /etc/nix/netrc
machine 127.0.0.1 password <token>
```

For CI, put the token in the URL instead of provisioning a file:

```sh
nix copy --to "http://x:$ODU_CACHE_TOKEN@127.0.0.1:18440/main" ./result
```

The server accepts any username and the token as the password.

## Private buckets

A public bucket reads without a token. Reads from a private bucket need the same credential as a write: netrc for `nix copy` and substitution, or `Authorization: Bearer <token>` for HTTP clients. Writes always need a token.

## Keep and reclaim

```sh
odu cache pin main release-1.2 ./result
odu cache gc main
odu cache stats
```

Pins are named and root a closure. Garbage collection applies per-bucket retention on last access: an object is evicted only when nothing retained in the bucket references it and it is not under a pin. NARs with no remaining references are deleted; blobs go last. `odu cache stats` reports sizes and hit counts.

## Protocol

One bucket is one substituter. Point any Nix-compatible tool at these routes:

```text
GET  /<bucket>/nix-cache-info             StoreDir, WantMassQuery: 1, Priority: 40
HEAD /<bucket>/<hash>.narinfo
GET  /<bucket>/<hash>.narinfo
GET  /<bucket>/nar/<filehash>.nar.zst     stream, or 302 to a presigned URL
PUT  /<bucket>/nar/<filehash>.nar.<ext>   Bearer or Basic; any ext Nix sends
PUT  /<bucket>/<hash>.narinfo             server re-signs with the bucket key
POST /_odu/v1/buckets/<bucket>/missing    batch "which of these are you missing"
```

Writes, and reads of private buckets, accept `Authorization: Bearer <token>` or HTTP Basic with any username and the token as the password. Nix uses the second through curl on every request, uploads included. The `missing` route backs `odu cache push`; it is not part of the Nix protocol.

## CLI reference

| Command | What it does |
| --- | --- |
| `odu cache create <bucket>` | Create a bucket; print its substituter URL and public key |
| `odu cache list` | List buckets |
| `odu cache use <bucket>` | Print the substituter and key settings, the `nixConfig` block, and the netrc lines |
| `odu cache token mint <bucket> --write\|--read\|--admin` | Mint a token, printed once |
| `odu cache token list` | List tokens with scope, expiry and last use |
| `odu cache token revoke <id>` | Revoke one token |
| `odu cache login <origin>` | Save a token for an origin in `~/.config/odu/cache/credentials` |
| `odu cache push <bucket> <paths…>` | Upload only the paths the bucket is missing |
| `odu cache pin <bucket> <name> <paths…>` | Pin a closure against garbage collection |
| `odu cache gc [bucket]` | Evict objects past retention that nothing references and no pin holds |
| `odu cache stats` | Show storage and hit counts |
