---
title: Nix binary cache
description: Serve a Nix binary cache from odu, point Nix at a bucket, and read a private one.
section: Binary cache
order: 0
---

`odu web` also serves Nix binary caches. It speaks the standard Nix HTTP binary cache protocol, so every Nix client works unchanged. A **bucket** is one cache: one substituter URL under the service's origin, and one public key the service signs with.

Commands are written with the [`odu` shorthand](/docs/#quick-start).

## Create a bucket

```sh
odu surface cache bucket_create --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","name":"main","public":true,"retentionDays":30}' --json
```

On the board, an admin creates one under **Cache** → **New bucket** → **Create bucket**. The CLI has no command for it.

`bucket_create` returns the substituter URL and the bucket's public key. Its inputs (whether the bucket is public, its retention, whether it skips upstream-signed paths, and its store) are in the [command reference](/docs/cache/reference/#bucket_create).

## Use it

Trust the key, and a build substitutes from the bucket instead of building. The bucket's **Set up** block on the board shows each setting in its own tab, and `odu cache use main` prints them in a terminal.

On a machine with the Nix daemon, put the two lines in the machine's Nix configuration: `/etc/nix/nix.conf`, or `nix.settings` on NixOS and nix-darwin. The daemon takes them from anywhere else only for a user in its `trusted-users`.

| Where the two lines are | Who gets the bucket |
| --- | --- |
| the machine's Nix configuration | every user on the machine |
| a user's own `~/.config/nix/nix.conf`, or `--option` on the command line | only a user in the daemon's `trusted-users` |
| a flake's `nixConfig`, accepted with `--accept-flake-config` | a trusted user, or any user once the machine lists the address under `trusted-substituters` and the key under `trusted-public-keys` |
| the address in the machine's configuration, without the key | nobody: Nix refuses the bucket's paths as unsigned |

A line Nix will not use is a warning, not an error, and Nix then builds the path itself. Without the key, the warning says the path is not signed by any of the keys in `trusted-public-keys`.

`/etc/nix/nix.conf`, then restart the Nix daemon:

```sh
extra-substituters = http://127.0.0.1:18440/cache/main
extra-trusted-public-keys = main-1:<public-key>
```

NixOS / nix-darwin:

```nix
nix.settings = {
  extra-substituters = [ "http://127.0.0.1:18440/cache/main" ];
  extra-trusted-public-keys = [ "main-1:<public-key>" ];
};
```

`flake.nix`, for the users the table above names:

```nix
{
  nixConfig = {
    extra-substituters = [ "http://127.0.0.1:18440/cache/main" ];
    extra-trusted-public-keys = [ "main-1:<public-key>" ];
  };
}
```

GitHub Actions, inside the step that installs Nix:

```yaml
extra_nix_config: |
  extra-substituters = http://127.0.0.1:18440/cache/main
  extra-trusted-public-keys = main-1:<public-key>
```

A private bucket's **Set up** block also has the netrc lines, because reading it needs a cache token:

```sh
# netrc — an absolute path, no ~
netrc-file = <home>/.netrc
machine 127.0.0.1:18440 password <your-read-token>
```

`odu cache use` needs no account for a public bucket, because a bucket's URL and public key are what it publishes to every client. It reads them from `GET /cache/<bucket>/`, which also returns a small page for `curl`, or JSON with `Accept: application/json`.

## Private buckets

A public bucket is read without a cache token. A private bucket is read with a cache token of read scope or wider, and every write needs one.

| Client | How it sends the cache token |
| --- | --- |
| `nix copy`, substitution | the netrc lines above |
| any HTTP client | `Authorization: Bearer <token>` |

- An anonymous read of a private bucket returns 404, and a wrong, revoked, expired or other bucket's cache token returns 403. [How the cache works](/docs/cache/how-it-works/#why-a-private-bucket-answers-404) says why.
- `odu cache use` on a private bucket, without a credential, is refused: "if it is private, sign in (`odu auth login`) or set $ODU_TOKEN to a read token". With `$ODU_TOKEN` set to a read token, it prints the block.

## Find your page

| You want to | Read |
| --- | --- |
| <span id="tokens"></span>mint, list or revoke a cache token | [Tokens](/docs/cache/tokens/) |
| <span id="push"></span>push paths to a bucket | [Push](/docs/cache/push/) |
| <span id="push-from-github-actions"></span>push from a GitHub workflow | [Push from GitHub Actions](/docs/cache/github-actions/) |
| <span id="keep-and-reclaim"></span>keep a closure, see why a path is still here, or collect garbage | [Keep and reclaim](/docs/cache/retention/) |
| <span id="keep-a-bucket-on-s3"></span>keep a bucket's objects on R2 or another S3 store | [Keep a bucket on S3](/docs/cache/s3/) |
| <span id="a-domain-for-a-bucket"></span>give a bucket a domain of its own | [A domain for a bucket](/docs/cache/domain/) |
| <span id="reads-leave-odu"></span>understand why reads go to the store, and other choices | [How the cache works](/docs/cache/how-it-works/) |
| <span id="where-the-data-lives"></span><span id="operating-it"></span>find the files, size the disk, back up, or read the log | [Operate the cache](/docs/cache/operations/) |
| <span id="protocol"></span>write a client against the cache's routes | [Protocol](/docs/cache/protocol/) |
| <span id="command-reference"></span><span id="the-cache-view"></span>look up a cache command, API verb or board control | [Command reference](/docs/cache/reference/) |
