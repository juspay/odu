# odu's own CI pipeline — consumed by odu itself (`nix run .#odu -- run`).
# The runner discovers the recipe tagged [metadata("ci")], expands its
# reachable dependency subgraph, and runs each leaf via
# `just --no-deps <namepath>`.

set working-directory := '..'

nix_shell := if env('IN_NIX_SHELL', '') != '' { '' } else { 'nix develop --accept-flake-config -c' }

# See the justfile's copy: PLAYWRIGHT_BROWSERS_PATH, not IN_NIX_SHELL, because
# the default shell sets the latter and supplies no browsers.
nix_shell_e2e := if env('PLAYWRIGHT_BROWSERS_PATH', '') != '' { '' } else { 'nix develop .#e2e --accept-flake-config -c' }

[parallel]
[metadata("ci")]
default: typecheck unit fmt nix e2e web-acceptance bun-nix-fresh

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

# Black-box e2e: builds the odu binary with nix and drives it against a
# throwaway fixture repo on a localhost lane (tests/e2e/README.md). Needs the
# dev shell on PATH (nix, git, just, bun) plus the node_modules from `install`.
#
# `nix` IS A PREREQUISITE for the same reason it is one for `web-acceptance`
# below: this leg builds `.#odu` too, and without the edge the two race. The
# loser pays for the whole build INSIDE a test's own timeout — which is exactly
# how `cancel.e2e.test.ts` came to fail with "timed out waiting for the run to
# serve its socket" after ten minutes on a builder whose store was cold, while
# `ci::nix` beside it reported success in 24 seconds and `web-acceptance`, which
# has the edge, finished in 37. The failure reads as a flaky test and is a
# missing dependency; the log gives it away, being two-fifths substituter noise
# from a build that should have been a lookup.
e2e: install nix
    {{ nix_shell }} bun run test:e2e

# Browser acceptance: Cucumber features driven through Playwright against the
# nix-built binary, with the browsers supplied by nixpkgs
# (packages/web-acceptance/README.md).
#
# REQUIRED on every platform, deliberately. odu's previous browser coverage
# skipped itself where no Chrome was on PATH, so on a runner it graded nothing
# and the one environment where a regression is caught by somebody other than its
# author was the one environment that never looked. If this leg is too slow for
# the workflow's `timeout-minutes`, raise that number — a platform-conditional
# skip would put the silent gap straight back.
#
# `nix` is a prerequisite as well as a build here so the binary is an
# already-realised lookup rather than a second build racing that leg's.
web-acceptance: install nix
    #!/usr/bin/env bash
    set -euo pipefail
    odu="$(nix build .#odu --no-link --print-out-paths --accept-flake-config)/bin/odu"
    nix build .#odu-runner --no-link --accept-flake-config
    cd packages/web-acceptance
    ODU_BIN="$odu" {{ nix_shell_e2e }} bun run test

fmt:
    {{ nix_shell }} nixpkgs-fmt --check *.nix nix/*.nix nix/packages/*.nix

nix:
    nix build .#odu .#odu-runner .#web-ui --no-link

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
