#!/usr/bin/env sh
# Materialize EVERY npins-hydrated package into ./node_modules — the one list.
#
# The pairs used to live in two recipe bodies (`justfile`'s `install` and
# `ci/mod.just`'s), and they drifted the first time one grew: the lane hydrated
# every `@kolu/*` package and not `@olai/effect-cordis`, so `ci::typecheck` on a
# lane failed on a module the developer's own shell had. A list of (source,
# destination) pairs that two callers must agree on belongs in ONE file.
#
# The sources are the npins pins' store paths, exported by the dev shell
# (`nix/env.nix`). Run this from the repository root, inside that shell.
set -eu

if [ -z "${IN_NIX_SHELL:-}" ]; then
  echo "hydrate-pins.sh: run this inside the dev shell (nix develop)" >&2
  exit 1
fi

exec sh "$(dirname "$0")/hydrate-kolu-packages.sh" \
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
  "$ODU_OSFACTS_CLIENT" osfacts-client \
  "$ODU_OLAI_EFFECT_CORDIS" @olai/effect-cordis \
  $ODU_CORDIS_HYDRATE
