#!/usr/bin/env bash
# Reproducible terminal evidence for `odu cache push --whole`.
#
# A two-path closure is built, and its dependency is signed with a key named
# `cache.nixos.org-1`, the way a nixpkgs path arrives. A default bucket skips
# that path as upstream, so `nix copy --from <bucket>` (which reads that one
# cache) cannot fetch the closure into an empty store. The same push with
# `--whole` stores it, and the same copy then succeeds.
#
# Recorded with asciinema, rendered to a gif with agg — see
# dev/skills/pr-evidence/SKILL.md:
#
#   odu=$(nix build .#odu --no-link --print-out-paths)/bin/odu
#   asciinema rec --headless --window-size 100x30 -i 2 --overwrite \
#     -c "bash tests/evidence/whole-push-demo.sh $odu $PWD" /tmp/whole-push.cast
#
# Linux only: the closure is built into a diverted store. Nothing here touches
# your store or your own `odu web`: everything is under one temp dir.
set -u
ODU="$1"          # the odu under test (nix-built: the wrapper bakes ODU_SELF)
WT="$2"           # the odu checkout
PORT="${PORT:-18994}"
JQ=$(command -v jq || echo "")
[ -n "$JQ" ] || JQ="$(nix build nixpkgs#jq.bin --no-link --print-out-paths)/bin/jq"

ROOT=$(mktemp -d /tmp/odu-whole-push-XXXX)
BUILDER="local?root=$ROOT/builder"
printf '{"%s":"localhost"}' "$(nix eval --impure --raw --expr builtins.currentSystem)" \
  > "$ROOT/hosts.json"

export ODU_STATE_DIR="$ROOT/state" ODU_HOSTS="$ROOT/hosts.json"
export ODU_WEB_ORIGIN="http://127.0.0.1:$PORT"
export ODU_ROOT_TOKEN="demo-root-token"

daemon_pid() { "$ODU" surface get service 2>/dev/null | grep -o '"pid": *[0-9]*' | grep -o '[0-9]*$'; }
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

# THE CONSUMER'S COMMAND: one cache, an empty store, and a narinfo cache of its
# own so no earlier answer stands in for the bucket's.
fetch_alone() {
  cmd "nix copy --from $URL --to local?root=<empty> …-whole-demo-app"
  XDG_CACHE_HOME="$ROOT/xdg-$1" nix copy --extra-trusted-public-keys "$KEY" \
    --from "$URL" --to "local?root=$ROOT/$1" "$APP" 2>&1 | sed 's/^/  /'
  printf '  [exit %s]\n' "${PIPESTATUS[0]}"
  sleep 2
}

# ── the service, a default bucket ────────────────────────────────────────────
say "odu web, and a bucket with the default upstream key (cache.nixos.org-1)."
cmd "odu web --background"
"$ODU" web --background 2>&1 | grep -E "started|http"; sleep 1.5
cmd "odu surface cache bucket_create --input '{…\"name\":\"main\"}' --json"
BUCKET=$("$ODU" surface cache bucket_create --input "$(admin '"name":"main","public":true')" --json)
printf '%s\n' "$BUCKET" | "$JQ" -r '"  \(.name): skips paths signed by \(.upstreamKeys | join(", "))"'
URL=$(printf '%s' "$BUCKET" | "$JQ" -r .url)
KEY=$(printf '%s' "$BUCKET" | "$JQ" -r .publicKey)
TOKEN=$("$ODU" surface cache token_mint --input "$(admin '"bucket":"main","scope":"write"')" \
  --json | "$JQ" -r .token)
sleep 1

# ── a closure whose dependency an upstream key signed ────────────────────────
say "An app that depends on a library the upstream key signed, as nixpkgs is."
LIB='derivation { name = "whole-demo-lib"; system = builtins.currentSystem; builder = "/bin/sh"; args = [ "-c" "echo lib > $out" ]; }'
APP=$(nix build --store "$BUILDER" --no-link --print-out-paths --impure --expr \
  "let lib = $LIB; in derivation { name = \"whole-demo-app\"; system = builtins.currentSystem; builder = \"/bin/sh\"; args = [ \"-c\" \"echo \${lib} > \$out\" ]; }" 2>/dev/null)
LIBPATH=$(nix path-info --store "$BUILDER" --recursive "$APP" | grep whole-demo-lib)
nix key generate-secret --key-name cache.nixos.org-1 > "$ROOT/upstream.key"
nix store sign --store "$BUILDER" --key-file "$ROOT/upstream.key" "$LIBPATH" 2>/dev/null
nix path-info --store "$BUILDER" --recursive --sigs "$APP" | sed -E 's|/nix/store/[a-z0-9]+-|…-|; s|:[A-Za-z0-9+/=]{20,}|:…|g; s/^/  /'
sleep 2

# ── without --whole ──────────────────────────────────────────────────────────
say "A plain push skips the upstream-signed library."
cmd "odu cache push main …-whole-demo-app"
NIX_REMOTE="$BUILDER" ODU_CACHE_TOKEN="$TOKEN" "$ODU" cache push main "$APP" 2>&1 \
  | grep -vE '^$' | sed -E 's|/nix/store/[a-z0-9]+-|…-|g; s/^/  /'
sleep 1
say "A client that reads only this bucket cannot take the closure."
fetch_alone before

# ── with --whole ─────────────────────────────────────────────────────────────
say "The same push with --whole stores the library too."
cmd "odu cache push main …-whole-demo-app --whole"
NIX_REMOTE="$BUILDER" ODU_CACHE_TOKEN="$TOKEN" "$ODU" cache push main "$APP" --whole 2>&1 \
  | grep -vE '^$' | sed -E 's|/nix/store/[a-z0-9]+-|…-|g; s/^/  /'
sleep 1
say "The same copy, into another empty store, now takes it from this bucket alone."
fetch_alone after
sleep 2
