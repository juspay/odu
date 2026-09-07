nix_shell := if env('IN_NIX_SHELL', '') != '' { '' } else { 'nix develop ' + justfile_directory() + ' --accept-flake-config -c' }

mod ci 'ci/mod.just'

# List available recipes
default:
    @just --list

# Install deps (bun) and hydrate the @kolu/* surface libraries from the
# npins kolu pin (sh -c so $ODU_KOLU_* expand inside the dev shell that
# exports them).
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

# TypeScript type checking
typecheck: install
    {{ nix_shell }} bun run typecheck

# Unit tests (the loopback falsifiability suite)
test: install
    {{ nix_shell }} bun run test:unit

# Black-box e2e: build the odu binary with nix and drive it against a
# throwaway fixture repo on a localhost lane (tests/e2e/README.md).
e2e: install
    {{ nix_shell }} bun run test:e2e

# Run odu from THIS checkout, as a package: `just run -- run --no-strict biome`.
#
# NIX IS THE ONLY SUPPORTED WAY TO RUN ODU, and this recipe is that rule applied
# to local development. It used to be `bun run start`, which is a raw bun entry
# with no wrapper — so it had none of the locators the wrapper bakes (ODU_SELF,
# ODU_WEB_DIST, ODU_BUILD_ID, the pinned nix/git/gh/just), and every one of those
# absences had a runtime fallback keeping it alive. Running that way exercised an
# application no user has. Those fallbacks are gone and so is the recipe.
#
# The cost is honest: an edit under `src/` or `packages/` now rebuilds `base`
# (a sandboxed bun install + hydrate) before it runs. `just test`, `just
# typecheck` and `just e2e` still drive bun directly in the devshell — bun there
# is a TEST runtime, not a second way to run the application.
run *args:
    {{ nix_shell }} nix run --accept-flake-config {{ justfile_directory() }} -- {{ args }}

# Serve the web service from this checkout, browser page included.
#
# `just run -- web` does this too; the recipe survives only as the obvious name.
# There is no dist-building step any more: the bundle is part of the package
# (default.nix's `web-ui`), so a service either has its page or is a misbuilt
# package that refuses to start. Ctrl-C stops it.
web *args: (run "web" args)

# The site lives in website/ as a standalone npm project (its own
# package-lock.json, not the root bun.lock), so this shells in and uses npm. Pass
# Astro flags through, e.g. `just website --port 3000 --open`.
# Preview the marketing website locally (Astro dev server, hot reload).
website *args:
    {{ nix_shell }} sh -c 'cd website && npm install && npm run dev -- {{ args }}'

# Format nix files
fmt:
    {{ nix_shell }} nixpkgs-fmt *.nix nix/*.nix nix/packages/*.nix

fmt-check:
    {{ nix_shell }} nixpkgs-fmt --check *.nix nix/*.nix nix/packages/*.nix

# Regenerate bun.nix from bun.lock. Run this after any change to bun.lock
# (i.e. after `bun install`/`bun add`).
regenerate-bun-nix:
    {{ nix_shell }} sh -c 'nix run .#bun2nix -- -l bun.lock -o bun.nix && nixpkgs-fmt bun.nix'

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
