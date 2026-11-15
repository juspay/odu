---
title: Self-host on NixOS
description: Run odu's board, CI and cache on a NixOS server with its module, or on any host from the environment it sets.
section: Run the service
order: 2
---

The board, the CI runs and the cache are one process, and odu's flake ships a NixOS module for all three. This page sets up a server with the module, then lists what a host without the module sets instead.

Commands are written with the [`odu` shorthand](/docs/#quick-start).

## Add the module

Add the flake and import its module:

```nix
{
  inputs.odu.url = "github:juspay/odu";
}
```

```nix
{ config, inputs, ... }:
{
  imports = [ inputs.odu.nixosModules.default ];

  # `cache.enableACME` is on by default, and Let's Encrypt wants both of these.
  # Accepting the terms is your act, not the module's.
  security.acme = {
    acceptTerms = true;
    defaults.email = "you@example.com";
  };

  # Any secret file works. agenix is the example.
  age.secrets.odu-root-token = {
    file = ./secrets/odu-root-token.age;
    owner = "odu";
    mode = "0400";
  };

  services.odu = {
    enable = true;
    cache.domain = "cache.example.com";
    rootTokenFile = config.age.secrets.odu-root-token.path;
    openFirewall = true;
  };
}
```

## What the module sets up

- The service listens on loopback and runs as the `odu` system user.
- Its state is in `/var/lib/odu`, at mode 0700, because the cache's signing keys are there.
- The root token arrives as a systemd credential and is exported into the unit's environment. It is never written into the Nix store.
- nginx serves one virtual host for `cache.domain`. It proxies `/cache/`, `/_odu/v1/` and `/metrics`, and returns 404 for everything else.
- `cache.domain` also sets the origin a bucket is published under, so the URL `odu cache use` prints is one your clients can reach.

> Without [server mode](/docs/server-mode/), the board and `/mcp` have no authentication, so the module keeps them off the public internet. With `services.odu.github` set, nginx serves them too, behind GitHub sign-in.

The module requires the service to listen on loopback, because it must sit behind a proxy. Without sign-in nothing authenticates a request, and with sign-in the session cookie needs TLS.

## Create the first bucket

Reach the board over a tailnet or an SSH forward to `127.0.0.1:18440`, then create the bucket and mint a cache token:

```sh
export ODU_ROOT_TOKEN=...
odu surface cache bucket_create --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","name":"main","public":true,"retentionDays":30}' --json
odu surface cache token_mint --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","bucket":"main","scope":"write"}' --json
```

On a client, trust the bucket with the key `bucket_create` printed:

```nix
{
  nix.settings = {
    extra-substituters = [ "https://cache.example.com/cache/main" ];
    extra-trusted-public-keys = [ "main-1:<public-key>" ];
  };
}
```

What a bucket keeps, and for how long, is on [Keep and reclaim](/docs/cache/retention/).

## Keep objects on S3, or give a bucket a domain

A bucket can keep its objects on an S3 store (Cloudflare R2, AWS, Garage or versitygw) instead of the server's disk. Declare the store in the module and name it at creation:

```nix
services.odu.cache.stores.r2 = {
  endpoint = "https://<account>.r2.cloudflarestorage.com";
  bucket = "odu-cache";
  region = "auto";
  credentialsFile = config.age.secrets.odu-r2.path; # AWS_ACCESS_KEY_ID=… / AWS_SECRET_ACCESS_KEY=…
};
```

Then add `"store":"r2"` to the `bucket_create` input. The credentials file is a systemd credential, like the root token. [Keep a bucket on S3](/docs/cache/s3/) has the rest.

A bucket can also have a domain of its own, served through a Cloudflare tunnel with no port opened. It needs a Cloudflare API token (`services.odu.cloudflare.apiTokenFile`), and `cache.bucketDomains` gives each name a virtual host and a certificate on a module host. [A domain for a bucket](/docs/cache/domain/) has the steps.

## Without the module

A container, or any host without systemd, runs the same one process from the environment the module sets, and needs nothing else.

| Variable | What it sets |
| --- | --- |
| `ODU_STATE_DIR` | where everything is kept: the run history, the cache, and the service's own lock and socket. Set it when `$HOME` is read-only. |
| `ODU_WEB_ORIGIN` | the address the service listens on |
| `ODU_PUBLIC_ORIGIN` | the address a bucket's URL is published under when a proxy stands in front. The module derives it from `cache.domain` and `cache.enableACME`. |
| `ODU_ROOT_TOKEN` | the root token, the secret that administers the cache |
| `ODU_OBJECT_STORES` | a JSON file of declared S3 stores, the shape the module writes. See [Keep a bucket on S3](/docs/cache/s3/#declare-the-store). |
| `ODU_WEB_ALLOWED_ORIGINS` | browser origins the service accepts besides its own. The module's `allowedOrigins`. |
| `ODU_CLOUDFLARE_API_TOKEN_FILE` | a file holding the Cloudflare API token. The module's `cloudflare.apiTokenFile`. |
| `ODU_CACHE_STORE` | the old Nix store, only while [upgrading from a store-backed cache](#upgrade-from-a-store-backed-cache) |

Sign-in is set with `ODU_GITHUB_*`: see [Server mode](/docs/server-mode/). Where the files go, how big they get and what to back up is on [Operate the cache](/docs/cache/operations/).

## Upgrade from a store-backed cache

An older cache kept its paths in a Nix store. The service moves them into its object store in the background, and keeps serving while it does.

1. On a module host, leave `ODU_CACHE_STORE` unset: the old paths are in the host's `/nix/store`. In a container, point `ODU_CACHE_STORE` at the old chroot store.
2. Start the service. It serves at once, and runs the migration and the `CA:` pass in the background. Watch `cache.migration.*` and `cache.self_ca.*`.
3. Wait for `cache.migration.complete`.
4. On a module host, delete the abandoned roots under `<state>/cache/gcroots`, then run `nix-collect-garbage`. In a container, delete the old store directory. Never delete `/nix/store` itself.

A path the old store lacks has no object, and returns 404 until it is pushed again. Each is named by a `cache.migration.object_failed` line, and `cache.migration.incomplete` carries the counts. [Operate the cache](/docs/cache/operations/#the-one-time-migration) describes the migration.
