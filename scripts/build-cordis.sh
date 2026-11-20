#!/usr/bin/env sh
set -eu

if [ ! -d node_modules/cordis ]; then
  echo "build-cordis.sh: node_modules/cordis is not hydrated" >&2
  exit 1
fi

node_modules/.bin/tsc -p node_modules/cordis

bun build \
  --target=node \
  --format=esm \
  --packages external \
  --outfile node_modules/cordis/lib/index.js \
  node_modules/cordis/src/index.ts
