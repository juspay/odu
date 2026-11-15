#!/usr/bin/env bash
# Every internal link and #anchor in a built site must resolve.
#
# Usage: linkcheck.sh <site-dir>   (website/dist, after `npm run build`)
#
# Offline: external links are not fetched. Absolute links (`/docs/cache/push/#x`)
# resolve against <site-dir>.
set -euo pipefail

site=$(realpath "${1:?usage: linkcheck.sh <site-dir>}")

exec lychee \
  --offline \
  --include-fragments \
  --root-dir "$site" \
  --index-files index.html \
  --no-progress \
  --format detailed \
  "$site/**/*.html"
