nix_shell := if env('IN_NIX_SHELL', '') != '' { '' } else { 'nix develop ' + justfile_directory() + ' --accept-flake-config -c' }

mod ci 'ci/mod.just'

# List available recipes
default:
    @just --list

# Install npm deps and hydrate the @kolu/* surface libraries from the
# npins kolu pin (sh -c so $ODU_KOLU_* expand inside the dev shell that
# exports them).
install:
    {{ nix_shell }} pnpm install --frozen-lockfile
    {{ nix_shell }} sh -c 'sh scripts/hydrate-kolu-packages.sh \
      "$ODU_KOLU_SURFACE" @kolu/surface \
      "$ODU_KOLU_SURFACE_MCP" @kolu/surface-mcp \
      "$ODU_KOLU_SURFACE_NIX_HOST" @kolu/surface-nix-host'

# TypeScript type checking
typecheck: install
    {{ nix_shell }} pnpm typecheck

# Unit tests (the loopback falsifiability suite)
test: install
    {{ nix_shell }} pnpm test:unit

# Black-box e2e: build the odu binary with nix and drive it against a
# throwaway fixture repo on a localhost lane (tests/e2e/README.md).
e2e: install
    {{ nix_shell }} pnpm test:e2e

# Run odu from source: `just run -- run --no-strict biome`. The nix build bakes
# ODU_RUNNER_FLAKE onto the `odu` wrapper, but `pnpm start` is a raw tsx entry
# with no wrapper — and there is no fallback — so point the runner at this
# checkout (odu's own flake exports odu-runner; git+file sees live tracked edits
# and skips node_modules).
run *args: install
    {{ nix_shell }} env ODU_RUNNER_FLAKE="git+file://{{ justfile_directory() }}" pnpm start {{ args }}

# Format nix files
fmt:
    {{ nix_shell }} nixpkgs-fmt *.nix nix/*.nix nix/packages/*.nix

fmt-check:
    {{ nix_shell }} nixpkgs-fmt --check *.nix nix/*.nix nix/packages/*.nix

# Update the kolu / nixpkgs pins
update-pins:
    nix run nixpkgs#npins -- update

# Regenerate the APM-managed agent config (.claude/, .mcp.json,
# apm.lock.yaml) from apm.yml + .apm/ sources. odu is a hybrid APM package,
# so this also self-deploys its own ci skill + odu MCP launcher (dogfooding,
# the way a consumer like kolu gets them). Run apm via uvx — never the
# system binary, which may be a stale version that mangles the lockfile.
apm:
    {{ nix_shell }} uvx --from apm-cli apm install
