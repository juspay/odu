---
title: The machines a run uses
description: Name the machines odu runs each platform on, what each machine needs, and how to see and hold them.
section: Use odu
order: 2
---

A run needs a machine for each platform it builds. You name them in a hosts file, or allow your own machine with `--host`. odu never builds anywhere you did not name.

Commands are written with the [`odu` shorthand](/docs/#quick-start).

## Name the machines

For a run on this machine only, pass `--host SYSTEM=localhost`, such as `--host x86_64-linux=localhost`. For anything more, create `~/.config/odu/hosts.json`:

```json
{
  "x86_64-linux": ["ci@linux-a", "ci@linux-b"],
  "aarch64-darwin": "ci@mac"
}
```

Each platform names one machine or a pool of them. A run leases one available machine per platform from its pool. Do not mix localhost and remote machines in one pool.

odu reads the first of these files that exists:

1. `$ODU_HOSTS`
2. `~/.config/odu/hosts.json`
3. `~/.config/justci/hosts.json`

No configured machine means a refusal, never an implicit local build.

## What a remote machine needs

- SSH access.
- Nix.
- Outbound HTTPS.
- odu's runner for its Nix system, which odu takes from the same build as itself.

A published odu revision reaches a Linux machine on Nix 2.17–2.34 with no cache key on the machine, because the machine pulls the content-addressed build itself. A macOS machine, or one on another Nix version, must trust odu's own binary cache in the machine's Nix configuration (`/etc/nix/nix.conf`, or `nix.settings`):

```ini
extra-substituters = https://cache.kolu.dev/kolu-r2
extra-trusted-public-keys = kolu-r2-1:7KmFrK05rVrnxkyZi9hJGnJJmRCpg87u6MUQIk7nokQ=
```

These are the two settings in odu's own flake. `--accept-flake-config` reads them from the flake too, but Nix honours them only for a trusted user. [Use it](/docs/cache/#use-it) has the rules for where the two lines go.

## See and hold the machines

On the board, **Machines** shows the service's last probe of the machines and how old it is. Opening the page contacts no machine. **Probe machines** takes a fresh probe, narrowed to the platforms you name.

```sh
odu ci hosts                    # what each platform has, and who holds it
odu ci lease x86_64-linux       # hold one across several runs
odu ci release x86_64-linux
```

- A lease belongs to the checkout and outlives the shell that took it, so release it when you are finished.
- `lease` reports `held`, `already` or `waiting`.

## Which hosts file a run reads

| Caller | Hosts file the service uses |
| --- | --- |
| the CLI | your shell's `$ODU_HOSTS`, forwarded |
| the board or an agent | the `hostsFile` it sends. Omitted, the service's own configuration. `""` skips the service's `$ODU_HOSTS`. |
| a retry | the same choice, and the same `--host` pins, as the run it retries |

A run on the server's checkout sends your `$ODU_HOSTS` differently: see [Run the server's CI from your shell](/docs/remote-runs/#which-machines-it-uses).
