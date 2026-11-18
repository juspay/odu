#!/usr/bin/env bash
# Reproducible terminal evidence for the netrc line odu prints.
#
# One throwaway service with a private bucket holding one built path. The
# build before this change and the build after it each print the bucket's
# netrc line with `odu cache use`; the line, with the read token filled in,
# is the whole netrc a `nix build` then reads from. Before, the line names
# `host:port` and Nix sends no credential, so the bucket answers "not found".
# After, it names the host and the path is fetched. Then a public bucket, for
# which the after build prints no netrc lines at all.
#
# Recorded with asciinema, rendered to a gif with agg (the pr-evidence skill):
#
#   before=$(nix build github:juspay/odu/<rev>#odu --no-link --print-out-paths)/bin/odu
#   after=$(nix build .#odu --no-link --print-out-paths)/bin/odu
#   asciinema rec --headless --window-size 100x34 -i 2 --overwrite \
#     -c "bash tests/evidence/netrc-host-demo.sh $before $after" /tmp/netrc-host.cast
#
# Linux only: the path is built into a diverted store, and every client store
# is a chroot under one temp dir. Nothing here touches your store or your own
# `odu web`.
set -u
BEFORE="$1"       # odu from the commit before this change
AFTER="$2"        # odu from this change (it also serves the buckets)
PORT="${PORT:-18998}"
JQ=$(command -v jq || echo "")
[ -n "$JQ" ] || JQ="$(nix build nixpkgs#jq.bin --no-link --print-out-paths)/bin/jq"

ROOT=$(mktemp -d /tmp/odu-netrc-host-XXXX)
BUILDER="local?root=$ROOT/builder"
printf '{"%s":"localhost"}' "$(nix eval --impure --raw --expr builtins.currentSystem)" \
  > "$ROOT/hosts.json"
export ODU_STATE_DIR="$ROOT/state" ODU_HOSTS="$ROOT/hosts.json"
export ODU_WEB_ORIGIN="http://127.0.0.1:$PORT"
export ODU_ROOT_TOKEN="demo-root-token"

daemon_pid() { "$AFTER" surface get service 2>/dev/null | grep -o '"pid": *[0-9]*' | grep -o '[0-9]*$'; }
cleanup() {
  pid=$(daemon_pid) && [ -n "$pid" ] && kill "$pid" 2>/dev/null
  chmod -R u+w "$ROOT" 2>/dev/null
  rm -rf "$ROOT"
}
trap cleanup EXIT

P='\033[1;32m$\033[0m'
say() { printf "\033[2;37m# %s\033[0m\n" "$1"; sleep 1.2; }
cmd() { printf "$P %s\n" "$1"; sleep 0.5; }
admin() { printf '{"rootToken":"%s",%s}' "$ODU_ROOT_TOKEN" "$1"; }

"$AFTER" web --background >/dev/null 2>&1
BUCKET=$("$AFTER" surface cache bucket_create --input "$(admin '"name":"main","public":false')" --json)
URL=$(printf '%s' "$BUCKET" | "$JQ" -r .url)
KEY=$(printf '%s' "$BUCKET" | "$JQ" -r .publicKey)
TOKEN=$("$AFTER" surface cache token_mint --input "$(admin '"bucket":"main","scope":"write"')" \
  --json | "$JQ" -r .token)
APP=$(nix build --store "$BUILDER" --no-link --print-out-paths --impure --expr \
  'derivation { name = "netrc-demo"; system = builtins.currentSystem; builder = "/bin/sh"; args = [ "-c" "echo private > $out" ]; }' 2>/dev/null)
NIX_REMOTE="$BUILDER" ODU_CACHE_TOKEN="$TOKEN" "$AFTER" cache push main "$APP" >/dev/null 2>&1

# ONE CLIENT: the netrc line this build of odu prints, and a fetch with it.
fetch_with() {
  local label="$1" odu="$2"
  cmd "ODU_TOKEN=<read token> odu cache use main | grep ^machine"
  line=$(ODU_TOKEN="$TOKEN" "$odu" cache use main | grep '^machine ')
  printf '  %s\n' "$line"
  printf '%s\n' "${line/<your-read-token>/$TOKEN}" > "$ROOT/netrc-$label"
  sleep 1
  cmd "nix build --substituters $URL --netrc-file <that line> …-netrc-demo"
  XDG_CACHE_HOME="$ROOT/xdg-$label" nix build --store "local?root=$ROOT/client-$label" \
    --substituters "$URL" --trusted-public-keys "$KEY" --netrc-file "$ROOT/netrc-$label" \
    --no-link "$APP" 2>&1 | grep -E "copying path|error:|warning:" \
    | sed -E 's|/nix/store/[a-z0-9]+-|…-|g; s/^/  /' | head -3
  printf '  [exit %s]\n' "${PIPESTATUS[0]}"
  sleep 2.5
}

say "A private bucket, one built path in it. Before: the line odu printed."
fetch_with before "$BEFORE"

say "After: the host alone, which is what Nix sends a credential for."
fetch_with after "$AFTER"

say "A public bucket is read with no credential: before, it printed netrc lines anyway."
"$AFTER" surface cache bucket_create --input "$(admin '"name":"open","public":true')" --json >/dev/null
cmd "odu cache use open | grep -c netrc    # before"
"$BEFORE" cache use open | grep -c netrc | sed 's/^/  /'
cmd "odu cache use open | grep -c netrc    # after"
"$AFTER" cache use open | grep -c netrc | sed 's/^/  /'
sleep 3
