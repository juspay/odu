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
      "$ODU_KOLU_SURFACE_NIX_HOST" @kolu/surface-nix-host'

# TypeScript type checking
typecheck: install
    {{ nix_shell }} pnpm typecheck

# Unit tests (the loopback falsifiability suite)
test: install
    {{ nix_shell }} pnpm test:unit

# Run odu from source: `just run -- run --no-strict biome`
run *args: install
    {{ nix_shell }} pnpm start {{ args }}

# Format nix files
fmt:
    {{ nix_shell }} nixpkgs-fmt *.nix nix/*.nix nix/packages/*.nix

fmt-check:
    {{ nix_shell }} nixpkgs-fmt --check *.nix nix/*.nix nix/packages/*.nix

# Update the kolu / nixpkgs pins
update-pins:
    nix run nixpkgs#npins -- update
