#!/usr/bin/env sh
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
  "$ODU_KOLU_BYTE_UNITS" @kolu/byte-units \
  "$ODU_KOLU_SURFACE_MAP" @kolu/surface-map \
  "$ODU_KOLU_LOG" @kolu/log \
  "$ODU_KOLU_SURFACE_DAEMON_SUPERVISOR" @kolu/surface-daemon-supervisor \
  "$ODU_KOLU_SURFACE_DAEMON" @kolu/surface-daemon \
  "$ODU_OSFACTS_CLIENT" osfacts-client \
  "$ODU_OLAI_EFFECT_CORDIS" @olai/effect-cordis \
  $ODU_CORDIS_HYDRATE
