# Odu CI: both e2e suites exercise the Nix-built application.

set working-directory := '..'

nix_shell := if env('IN_NIX_SHELL', '') != '' { '' } else { 'nix develop --accept-flake-config -c' }

# The default devshell has no browsers; use the e2e shell unless they are present.
nix_shell_e2e := if env('PLAYWRIGHT_BROWSERS_PATH', '') != '' { '' } else { 'nix develop .#e2e --accept-flake-config -c' }

[parallel]
[metadata("ci")]
default: typecheck unit fmt nix agent-flake-nix e2e-cli e2e-web bun-nix-fresh nixos-module

install:
    {{ nix_shell }} bun install --frozen-lockfile
    {{ nix_shell }} sh -c 'sh scripts/hydrate-kolu-packages.sh \
      "$ODU_KOLU_SURFACE" @kolu/surface \
      "$ODU_KOLU_SURFACE_MCP" @kolu/surface-mcp \
      "$ODU_KOLU_SURFACE_APP" @kolu/surface-app \
      "$ODU_KOLU_SURFACE_CLI" @kolu/surface-cli \
      "$ODU_KOLU_URL_SHAPE" @kolu/url-shape \
      "$ODU_KOLU_SURFACE_REMOTE" @kolu/surface-remote \
      "$ODU_KOLU_SHELL_QUOTE" @kolu/shell-quote \
      "$ODU_KOLU_SURFACE_MAP" @kolu/surface-map \
      "$ODU_KOLU_LOG" @kolu/log \
      "$ODU_KOLU_SURFACE_DAEMON_SUPERVISOR" @kolu/surface-daemon-supervisor \
      "$ODU_KOLU_SURFACE_DAEMON" @kolu/surface-daemon \
      "$ODU_OSFACTS_CLIENT" osfacts-client'

typecheck: install
    {{ nix_shell }} bun run typecheck

unit: install
    {{ nix_shell }} bun run test:unit

# Build before e2e so a cold store cannot consume a test timeout.
e2e-cli: install nix
    {{ nix_shell }} bun run test:e2e-cli

e2e-web: install nix
    #!/usr/bin/env bash
    set -euo pipefail
    odu="$(nix build .#odu --no-link --print-out-paths --accept-flake-config)/bin/odu"
    nix build .#odu-runner --no-link --accept-flake-config
    cd packages/web-acceptance
    ODU_BIN="$odu" {{ nix_shell_e2e }} bun run test

# THE NIXOS MODULE, booted: two VMs, a real nginx, a real `nix copy` through it.
#
# `[linux]` because it boots a VM and the module is for servers. The
# x86_64-linux lane host has `/dev/kvm`, where this takes ~41 s warm and ~63 s
# when the VM image has to be built; without KVM the same test runs under TCG
# and takes many minutes, which is why the number is here rather than in a
# timeout.
[linux]
nixos-module:
    nix build .#checks.x86_64-linux.nixos-module --no-link --accept-flake-config

fmt:
    {{ nix_shell }} nixpkgs-fmt --check *.nix nix/*.nix nix/packages/*.nix

nix:
    nix build .#odu .#odu-runner .#web-ui .#agent-flake-source --no-link

# The AGENT SOURCE a remote dial resolves `odu-runner` from, evaluated exactly
# the way `@kolu/surface-remote` evaluates it.
#
# Load-bearing, not a nicety. `.#agent-flake-source` is ASSEMBLE-ONLY
# (`mkAgentSourceTree` — odu proves no attr through it), so the `nix` recipe
# above builds the tree without ever asking whether it exports the runner. What
# asks is this recipe, and it asks with the dial's own command, on the dial's
# own store path: a fileset or flake gap that reaches only a REMOTE host fails
# at `_ci-setup` on somebody's box, minutes into a lane, otherwise. Kolu carries
# the same guard over its `expose` inventory (`ci::agent-flake-nix`).
agent-flake-nix: nix
    #!/usr/bin/env bash
    set -euo pipefail
    source="$(nix build .#agent-flake-source --no-link --print-out-paths --accept-flake-config)"
    system="$(nix eval --impure --raw --expr builtins.currentSystem)"
    drv="$(nix eval --accept-flake-config --raw "$source#packages.$system.odu-runner.drvPath")"
    case "$drv" in
      *.drv) ;;
      *) echo "odu-runner resolved to '$drv', not a derivation path" >&2; exit 1 ;;
    esac

# Work around crates.io rejecting the fetchurl User-Agent on cold stores.
[private]
_prefetch-crates:
    {{ nix_shell }} bash scripts/ci-prefetch-crates.sh .

# Verify bun.nix was regenerated after lockfile changes.
bun-nix-fresh: _prefetch-crates
    {{ nix_shell }} sh -c '\
      set -eu; \
      tmp=$(mktemp -d); \
      trap "rm -rf $tmp" EXIT; \
      nix run .#bun2nix -- -l bun.lock -o "$tmp/bun.nix"; \
      nixpkgs-fmt "$tmp/bun.nix" >/dev/null; \
      diff -u bun.nix "$tmp/bun.nix" || { \
        echo; \
        echo "bun.nix is stale relative to bun.lock."; \
        echo "Run: just regenerate-bun-nix && git add bun.nix"; \
        exit 1; \
      }'
