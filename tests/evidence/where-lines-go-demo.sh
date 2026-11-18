#!/usr/bin/env bash
# Reproducible terminal evidence for where a bucket's two lines go.
#
# One throwaway service and one public bucket. `odu cache use` is run twice,
# by the build before this change and by the build after it: the block is
# printed by the CLIENT, from the facts the bucket publishes, so the same
# bucket shows both. Then the bucket's own page, as `curl` sees it.
#
# Recorded with asciinema, rendered to a gif with agg — see the pr-evidence
# skill:
#
#   before=$(nix build github:juspay/odu/<rev>#odu --no-link --print-out-paths)/bin/odu
#   after=$(nix build .#odu --no-link --print-out-paths)/bin/odu
#   asciinema rec --headless --window-size 100x40 -i 2 --overwrite \
#     -c "bash tests/evidence/where-lines-go-demo.sh $before $after" /tmp/where-lines-go.cast
#
# Nothing here touches your own `odu web`: everything is under one temp dir.
set -u
BEFORE="$1"       # odu from the commit before this change
AFTER="$2"        # odu from this change (it also serves the bucket)
PORT="${PORT:-18995}"

ROOT=$(mktemp -d /tmp/odu-where-lines-go-XXXX)
printf '{"%s":"localhost"}' "$(nix eval --impure --raw --expr builtins.currentSystem)" \
  > "$ROOT/hosts.json"
export ODU_STATE_DIR="$ROOT/state" ODU_HOSTS="$ROOT/hosts.json"
export ODU_WEB_ORIGIN="http://127.0.0.1:$PORT"
export ODU_ROOT_TOKEN="demo-root-token"

daemon_pid() { "$AFTER" surface get service 2>/dev/null | grep -o '"pid": *[0-9]*' | grep -o '[0-9]*$'; }
cleanup() {
  pid=$(daemon_pid) && [ -n "$pid" ] && kill "$pid" 2>/dev/null
  rm -rf "$ROOT"
}
trap cleanup EXIT

P='\033[1;32m$\033[0m'
say() { printf "\033[2;37m# %s\033[0m\n" "$1"; sleep 1.2; }
cmd() { printf "$P %s\n" "$1"; sleep 0.5; }

"$AFTER" web --background >/dev/null 2>&1
"$AFTER" surface cache bucket_create \
  --input "{\"rootToken\":\"$ODU_ROOT_TOKEN\",\"name\":\"main\",\"public\":true}" --json >/dev/null

say "Before: the lines, under 'nix.conf' and 'flake.nix', with nothing about whose file."
cmd "odu cache use main"
"$BEFORE" cache use main | sed -n '1,/^# GitHub Actions/p' | sed '$d'
sleep 3

say "After: where they go on a machine with the Nix daemon, and who the flake lines work for."
cmd "odu cache use main"
"$AFTER" cache use main | sed -n '1,/^# GitHub Actions/p' | sed '$d'
sleep 3

say "The bucket's own page says the same, above its blocks."
cmd "curl -s $ODU_WEB_ORIGIN/cache/main/ | grep 'class=\"hint\"'"
curl -s "$ODU_WEB_ORIGIN/cache/main/" | grep -o '<p class="hint">[^<]*' \
  | sed "s/<p class=\"hint\">/  /; s/&#39;/'/g" | head -2
sleep 3
