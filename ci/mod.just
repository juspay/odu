# odu's own CI pipeline — consumed by odu itself (`nix run .#odu -- run`).
# The runner discovers the recipe tagged [metadata("ci")], expands its
# reachable dependency subgraph, and runs each leaf via
# `just --no-deps <namepath>`.

set working-directory := '..'

nix_shell := if env('IN_NIX_SHELL', '') != '' { '' } else { 'nix develop --accept-flake-config -c' }

[parallel]
[metadata("ci")]
default: typecheck unit fmt nix e2e bun-nix-fresh

install:
    {{ nix_shell }} bun install --frozen-lockfile
    {{ nix_shell }} sh -c 'sh scripts/hydrate-kolu-packages.sh \
      "$ODU_KOLU_SURFACE" @kolu/surface \
      "$ODU_KOLU_SURFACE_MCP" @kolu/surface-mcp \
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

# Black-box e2e: builds the odu binary with nix and drives it against a
# throwaway fixture repo on a localhost lane (tests/e2e/README.md). Needs the
# dev shell on PATH (nix, git, just, bun) plus the node_modules from `install`.
e2e: install
    {{ nix_shell }} bun run test:e2e

fmt:
    {{ nix_shell }} nixpkgs-fmt --check *.nix nix/*.nix nix/packages/*.nix

nix:
    nix build .#odu .#odu-runner --no-link

# crates.io 403s the `curl/*` User-Agent nixpkgs fetchurl sends, so building
# bun2nix from source (askama / basic-toml / jsonc-parser …) fails on a runner
# whose store lacks it. Idempotent and cheap warm. See the script.
[private]
_prefetch-crates:
    {{ nix_shell }} bash scripts/ci-prefetch-crates.sh .

# bun.nix freshness — regenerate from bun.lock into a tmpdir and diff
# against the committed file. Fails the pipeline if bun.lock has moved
# without `just regenerate-bun-nix` being run.
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
