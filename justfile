nix_shell := if env('IN_NIX_SHELL', '') != '' { '' } else { 'nix develop ' + justfile_directory() + ' --accept-flake-config -c' }

# Gated on PLAYWRIGHT_BROWSERS_PATH rather than on IN_NIX_SHELL: the DEFAULT
# shell sets the latter without supplying browsers, so a developer already inside
# `nix develop` must still be sent into `.#e2e` to get them. Checking the wrong
# variable here would drop them into a suite that fails at chromium.launch().
#
# `.#e2e` is the DEVSHELL's name and stays as it is — it supplies browsers to
# whatever needs them, and is not one of the two suites.
nix_shell_e2e := if env('PLAYWRIGHT_BROWSERS_PATH', '') != '' { '' } else { 'nix develop ' + justfile_directory() + '#e2e --accept-flake-config -c' }

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

# BOTH end-to-end suites, and a failure in either fails this.
#
# They are one gate with two drivers, not a suite and an extra. Both drive the
# NIX-BUILT binary — the odu a user actually runs — and the only thing that
# differs is the door: `e2e-cli` comes in through the CLI, MCP and the daemon's
# own lifecycle; `e2e-web` comes in through a browser. Naming them `e2e` and
# `web-acceptance` said otherwise, and a name that says "acceptance" beside one
# that says "e2e" invites the reading that only one of them is the end-to-end
# gate.
#
# Dependencies, so `just e2e` fails on the first suite that does. Either one
# failing is this command failing; there is no arrangement in which the browser
# gate is the optional half.
e2e: e2e-cli e2e-web

# The CLI/MCP end-to-end gate: build the odu binary with nix and drive it
# against a throwaway fixture repo on a localhost lane (tests/e2e/README.md).
e2e-cli: install
    {{ nix_shell }} bun run test:e2e-cli

# The BROWSER end-to-end gate: Cucumber features driven through Playwright
# against the nix-built binary, which is the odu a user actually runs
# (packages/web-acceptance/README.md).
#
# It never skips. A machine with no browsers fails here with the sentence that
# gets them, because the previous arrangement — skip where no Chrome is on PATH —
# meant CI silently graded nothing.
#
# `cd` rather than `bun --cwd`: with `--cwd`, bun swallows the script name and
# prints its own help with status 0, which reads as a passing leg that ran no
# tests at all.
e2e-web: install
    #!/usr/bin/env bash
    set -euo pipefail
    odu="$(nix build .#odu --no-link --print-out-paths --accept-flake-config)/bin/odu"
    # Warm the store path every fixture run will realise, so the first scenario
    # pays a lookup rather than a build.
    nix build .#odu-runner --no-link --accept-flake-config
    cd packages/web-acceptance
    ODU_BIN="$odu" {{ nix_shell_e2e }} bun run test

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
#
# PINNED to the version the lockfile records it was generated by. It was
# unpinned, which meant `just apm` regenerated `.claude/` with whatever apm-cli
# happened to be newest that morning — and apm's deploy rules are exactly what
# this PR had to reverse-engineer to find out why a fresh consumer got a
# `.mcp.json` naming a file that did not exist. A generator whose behaviour is
# load-bearing and whose version floats is a diff nobody can reproduce.
# Bump this and `apm.lock.yaml`'s `apm_version` together, on purpose.
apm_version := "0.30.0"

apm:
    {{ nix_shell }} uvx --from apm-cli=={{ apm_version }} apm install
