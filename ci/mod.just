# odu's own CI pipeline — consumed by odu itself (`nix run .#odu -- run`).
# The runner discovers the recipe tagged [metadata("ci")], expands its
# reachable dependency subgraph, and runs each leaf via
# `just --no-deps <namepath>`.

set working-directory := '..'

nix_shell := if env('IN_NIX_SHELL', '') != '' { '' } else { 'nix develop --accept-flake-config -c' }

[parallel]
[metadata("ci")]
default: typecheck unit fmt nix e2e

install:
    {{ nix_shell }} pnpm install --frozen-lockfile
    {{ nix_shell }} sh -c 'sh scripts/hydrate-kolu-packages.sh \
      "$ODU_KOLU_SURFACE" @kolu/surface \
      "$ODU_KOLU_SURFACE_MCP" @kolu/surface-mcp \
      "$ODU_KOLU_SURFACE_NIX_HOST" @kolu/surface-nix-host'

typecheck: install
    {{ nix_shell }} pnpm typecheck

unit: install
    {{ nix_shell }} pnpm test:unit

# Black-box e2e: builds the odu binary with nix and drives it against a
# throwaway fixture repo on a localhost lane (tests/e2e/README.md). Needs the
# dev shell on PATH (nix, git, just) plus the vitest/tsx deps from `install`.
e2e: install
    {{ nix_shell }} pnpm test:e2e

fmt:
    {{ nix_shell }} nixpkgs-fmt --check *.nix nix/*.nix nix/packages/*.nix

nix:
    nix build .#odu .#odu-runner --no-link
