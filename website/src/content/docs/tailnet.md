---
title: A team server on a tailnet
description: Run odu on one Linux machine only your tailnet reaches, with a public bucket every team machine and CI lane reads, and pushes to with a write token.
section: Run the service
order: 5
---

This page sets up odu for a team on one Linux machine that only your tailnet can reach. Every team member's machine and every CI lane reads one public bucket with no credential, and pushes to it with a write cache token. `tailscale serve` puts HTTPS in front of odu.

> Anyone on the tailnet can read everything in the bucket. There is no read access per person, and removing someone from the tailnet is the only way to stop them reading. Writing still needs a write cache token.

The steps that rest on Tailscale and GitHub have not yet been run on a real tailnet:

- `tailscale serve` answering HTTPS at the tailnet name, and still serving after a reboot ([Reach it](#reach-it-through-tailscale-serve)).
- The name not answering off the tailnet, and `tailscale funnel status` ([Keep it tailnet-only](#keep-it-tailnet-only)).
- GitHub sign-in at the tailnet name, and the board staying live ([Sign in to the board](#sign-in-to-the-board)).
- A lane on the odu machine itself, reaching the bucket by its tailnet name ([Set up a CI lane](#set-up-a-ci-lane)).

The [tailnet check](https://github.com/juspay/odu/pull/186#issuecomment-6994878439) on the pull request that added this page says how to run each one, and what it should show.

Commands are written with the [`odu` shorthand](/docs/#quick-start). The machine is `odu` on the tailnet `example`, so its full name is `odu.example.ts.net`.

## Install odu on NixOS

Import odu's NixOS module and give it the root token from a secret file:

```nix
{ config, inputs, ... }:
{
  imports = [ inputs.odu.nixosModules.default ];

  # Any secret file works. agenix is the example.
  age.secrets.odu-root-token = {
    file = ./secrets/odu-root-token.age;
    owner = "odu";
    mode = "0400";
  };

  services.odu = {
    enable = true;
    rootTokenFile = config.age.secrets.odu-root-token.path;
    publicOrigin = "https://odu.example.ts.net";
    allowedOrigins = [ "https://odu.example.ts.net" ];
  };
}
```

The service listens on `http://127.0.0.1:18440` as the `odu` user. It keeps its runs and the bucket's objects on local disk, under `/var/lib/odu`. Leave `cache.domain` and `openFirewall` unset: the module then starts no nginx and opens no port. [Reach it through `tailscale serve`](#reach-it-through-tailscale-serve) explains `publicOrigin` and `allowedOrigins`.

## Install odu without NixOS

The machine needs Nix with the Nix daemon, and `git`. Create the service user and build odu at a pinned revision:

```sh
sudo useradd --system --home-dir /var/lib/odu --shell /usr/sbin/nologin odu
sudo nix build --accept-flake-config --out-link /opt/odu github:juspay/odu/<rev>#odu
sudo install -D -m 0400 ./root-token /etc/odu/root-token   # a file holding the root token
```

Then install this unit as `/etc/systemd/system/odu-web.service`. It sets the environment the NixOS module sets:

```ini
[Unit]
Description=odu: the board, its CI runs, and its binary cache
After=network.target nix-daemon.service

[Service]
User=odu
Group=odu
StateDirectory=odu
StateDirectoryMode=0700
Environment=ODU_STATE_DIR=/var/lib/odu
Environment=HOME=/var/lib/odu
Environment=ODU_WEB_ORIGIN=http://127.0.0.1:18440
Environment=ODU_PUBLIC_ORIGIN=https://odu.example.ts.net
Environment=ODU_WEB_ALLOWED_ORIGINS=https://odu.example.ts.net
Environment=PATH=/nix/var/nix/profiles/default/bin:/usr/bin:/bin
LoadCredential=root-token:/etc/odu/root-token
# The root token stays out of the unit: systemd copies the file into %d.
ExecStart=/bin/sh -c 'ODU_ROOT_TOKEN="$$(cat %d/root-token)" exec /opt/odu/bin/odu web'
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now odu-web
```

`odu web` runs in the foreground, so systemd sees its exit status. `PATH` gives it `nix` and `git`. [Self-host on NixOS](/docs/self-host/#without-the-module) lists every variable the service reads.

## Reach it through `tailscale serve`

`tailscale serve` answers HTTPS at the machine's tailnet name and forwards each request to odu on loopback. It needs MagicDNS and HTTPS certificates turned on for the tailnet, and the command offers to turn them on if they are off. On the odu machine:

```sh
sudo tailscale serve --bg http://127.0.0.1:18440
```

With `--bg`, it keeps serving after a reboot. odu is then at `https://odu.example.ts.net`.

Set `publicOrigin` (or `ODU_PUBLIC_ORIGIN`) to exactly that address, with `https://` and the full name. odu publishes every bucket under it, and session cookies are marked `Secure` because it starts with `https://`.

Use that one name everywhere: in each `flake.nix`, each Nix configuration, `odu cache login` and `--origin`. A run pushes only when the repository's `flake.nix` names a bucket under the service's public origin, so a short name or a tailnet IP address in a flake means a run that does not push.

`allowedOrigins` (or `ODU_WEB_ALLOWED_ORIGINS`) is the same address. odu accepts the board's live connection and `/mcp` from a browser whose `Origin` matches the request's `Host`, and from the origins listed there, so the board keeps working if the proxy hands odu a different `Host`.

## Keep it tailnet-only

| Keep | Why |
| --- | --- |
| `services.odu.listen` on loopback | The module refuses anything else. |
| `cache.domain`, `cache.bucketDomains` and `openFirewall` unset | The module then starts no nginx and opens no port. |
| `tailscale funnel` never run on this machine | Funnel would publish the board and the bucket to the internet. |

To check:

1. On the odu machine, `ss -ltn | grep 18440` lists `127.0.0.1:18440` and nothing else.
2. On the odu machine, `tailscale funnel status` shows no Funnel.
3. From a machine that is not on the tailnet, `curl -sS --max-time 10 https://odu.example.ts.net/` fails.

## Sign in to the board

Without sign-in, everyone on the tailnet controls CI. Turn on [server mode](/docs/server-mode/) before you hand the address out.

Create the GitHub App as that page says, with the callback URL `https://odu.example.ts.net/auth/github/callback`. Then add the App's settings to the module:

```nix
services.odu.github = {
  clientId = "Iv1.0123456789abcdef";
  clientSecretFile = config.age.secrets.odu-github-client-secret.path;
  allow = [ "org:example" ];
};
```

Without NixOS, set `ODU_GITHUB_CLIENT_ID` and `ODU_GITHUB_ALLOW` in the unit, and load the client secret with `LoadCredential=client-secret:<file>` and `ODU_GITHUB_CLIENT_SECRET_FILE=%d/client-secret`. Then make the first owner with the root token, as [Sign in and make the first owner](/docs/server-mode/#sign-in-and-make-the-first-owner) says.

The cache's routes stay open for reading a public bucket, with or without sign-in.

## Create the bucket and a write token

On the board, as an admin:

1. Open **Cache** → **New bucket**, name it `main` and click **Create bucket**. A bucket the board creates is public.
2. On the bucket's page, in the **Tokens** panel, choose write scope and click **Mint token**. The cache token is shown once, so copy it.

The bucket's address is `https://odu.example.ts.net/cache/main`, and its **Set up** panel shows the address and the key. [Tokens](/docs/cache/tokens/) has the API verbs for both steps.

## Set up a team member's machine

Put the bucket's address and key in the machine's own Nix configuration. In a user's own `nix.conf`, the Nix daemon ignores them for anyone not in its `trusted-users`, and Nix builds everything instead. [Use it](/docs/cache/#use-it) has the details.

On NixOS or nix-darwin:

```nix
nix.settings = {
  extra-substituters = [ "https://odu.example.ts.net/cache/main" ];
  extra-trusted-public-keys = [ "main-1:<public-key>" ];
};
```

With plain Nix, add the same two lines to `/etc/nix/nix.conf` and restart the Nix daemon:

```ini
extra-substituters = https://odu.example.ts.net/cache/main
extra-trusted-public-keys = main-1:<public-key>
```

`odu cache use main --origin https://odu.example.ts.net` prints both forms, with the real key.

## Set up a CI lane

A lane is one platform's share of a run, on one machine. The machine can be the odu machine itself, or another machine on the tailnet.

1. Give the lane's machine the same two lines, in its own Nix configuration, as for a team member. On the odu machine, that is its own `nix.settings`.
2. List the machines in the service user's hosts file, `/var/lib/odu/.config/odu/hosts.json`. `"localhost"` is the odu machine itself:

   ```json
   { "x86_64-linux": "localhost" }
   ```

   Another machine is named as the `odu` user reaches it over SSH, such as `"ci@builder"`. [The machines a run uses](/docs/machines/) says what each machine needs.
3. Clone each repository on the odu machine, owned by the `odu` user, such as `/var/lib/odu/checkouts/<repo>`. A run started from a laptop names this path.

Each repository's `flake.nix` names the bucket with the full address, as [Use odu from your repository](/docs/your-repository/) shows.

## Push from a laptop or a run

From a laptop, save the write cache token once, then push:

```sh
odu cache login https://odu.example.ts.net       # paste the write cache token
odu cache push --cache https://odu.example.ts.net/cache/main ./result
```

A run pushes what each recipe built to the bucket its `flake.nix` names, with a cache token that ends with the run. Start one from any shell on the tailnet with your personal token:

```sh
odu auth login https://odu.example.ts.net        # paste your personal token
odu ci run --origin https://odu.example.ts.net \
  --checkout /var/lib/odu/checkouts/<repo> --sha "$(git rev-parse HEAD)" --no-post
```

`--no-post` keeps the run off GitHub. Posting its statuses needs GitHub credentials for the `odu` user, which this page does not set up.

A run on your laptop's own odu does not push, because that odu serves no bucket. [Run the server's CI from your shell](/docs/remote-runs/) has the rest.
