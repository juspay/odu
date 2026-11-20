nix_shell := if env('IN_NIX_SHELL', '') != '' { '' } else { 'nix develop ' + justfile_directory() + ' --accept-flake-config -c' }

nix_shell_e2e := if env('PLAYWRIGHT_BROWSERS_PATH', '') != '' { '' } else { 'nix develop ' + justfile_directory() + '#e2e --accept-flake-config -c' }

mod ci 'ci/mod.just'

# List available recipes
default:
    @just --list

# up without the plugin runtime while the developer's shell had it.)
install:
    {{ nix_shell }} bun install --frozen-lockfile
    {{ nix_shell }} sh scripts/hydrate-pins.sh

# TypeScript type checking
typecheck: install
    {{ nix_shell }} bun run typecheck

# Unit tests (the loopback falsifiability suite)
test: install
    {{ nix_shell }} bun run test:unit

# gate is the optional half.
e2e: e2e-cli e2e-web

# against a throwaway fixture repo on a localhost lane (tests/e2e/README.md).
e2e-cli: install
    {{ nix_shell }} bun run test:e2e-cli

# tests at all.
e2e-web: install
    #!/usr/bin/env bash
    set -euo pipefail
    odu="$(nix build .#odu --no-link --print-out-paths --accept-flake-config)/bin/odu"
    nix build .#odu-runner --no-link --accept-flake-config
    cd packages/web-acceptance
    ODU_BIN="$odu" {{ nix_shell_e2e }} bun run test

# is a TEST runtime, not a second way to run the application.
run *args:
    {{ nix_shell }} nix run --accept-flake-config {{ justfile_directory() }} -- {{ args }}

# package that refuses to start. Ctrl-C stops it.
web *args: (run "web" args)

# Preview the marketing website locally (Astro dev server, hot reload).
website *args:
    {{ nix_shell }} sh -c 'cd website && npm install && npm run dev -- {{ args }}'

# (dev/skills/docs-writing/SKILL.md).
website-check:
    {{ nix_shell }} sh -c 'cd website && npm ci && npm run check && npm test'

# resolve. lychee comes from the pinned nixpkgs, not the dev shell.
website-linkcheck:
    {{ nix_shell }} sh -c 'cd website && npm ci && npm run build'
    nix shell --impure --expr '(import ./nix/nixpkgs.nix { }).lychee' -c website/linkcheck.sh website/dist

# Format nix files
fmt:
    {{ nix_shell }} nixpkgs-fmt *.nix nix/*.nix nix/packages/*.nix

fmt-check:
    {{ nix_shell }} nixpkgs-fmt --check *.nix nix/*.nix nix/packages/*.nix

# (i.e. after `bun install`/`bun add`).
regenerate-bun-nix:
    {{ nix_shell }} sh -c 'nix run .#bun2nix -- -l bun.lock -o bun.nix && nixpkgs-fmt bun.nix'

# Update the kolu / nixpkgs pins
update-pins:
    nix run nixpkgs#npins -- update
