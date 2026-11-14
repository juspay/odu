#!/usr/bin/env bash
# Reproducible terminal evidence for the Paths tab's "kept by" column (cache 4.9).
#
# Two paths are pushed to a bucket and one of them is pinned. `bucket_paths`
# then says, per path, what keeps it — `pin` for the pinned one, `retention`
# with the day its clock runs out for the other — and, once the bucket's
# retention is set to zero, `nothing` for the unpinned one: exactly the path
# the dry run says the next collection takes.
#
# Recorded with asciinema, rendered to a gif with agg — see
# dev/skills/pr-evidence/SKILL.md:
#
#   odu=$(nix build .#odu --no-link --print-out-paths)/bin/odu
#   asciinema rec --headless --window-size 100x30 -i 2 --overwrite \
#     -c "bash tests/evidence/kept-by-demo.sh $odu $PWD" /tmp/kept-by.cast
#
# Nothing here touches your store or your own `odu web`: the daemon's state and
# the builder store are under one temp dir.
set -u
ODU="$1"          # the odu under test (nix-built: the wrapper bakes ODU_SELF)
WT="$2"           # the odu checkout
PORT="${PORT:-18993}"
JQ=$(command -v jq || echo "")
[ -n "$JQ" ] || JQ="$(nix build nixpkgs#jq.bin --no-link --print-out-paths)/bin/jq"

ROOT=$(mktemp -d /tmp/odu-kept-by-XXXX)
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

# What the Paths tab's column reads: one line per path, its name and its verdict,
# with `until` as a date a person reads.
PATHS_JQ='.paths[] | "\(.storePath | sub("^/nix/store/[a-z0-9]+-"; ""))  \(.keptBy.kind)'
PATHS_JQ+='\(if (.keptBy.pins | length) > 0 then " " + (.keptBy.pins | join(",")) else "" end)'
PATHS_JQ+='  until \(.keptBy.until / 1000 | strftime("%Y-%m-%d"))"'
kept_by() {
  cmd "odu surface cache bucket_paths --input '{\"bucket\":\"main\"}' --json | jq '.paths[] | …keptBy…'"
  "$ODU" surface cache bucket_paths --input '{"bucket":"main"}' --json \
    | "$JQ" -r "$PATHS_JQ" | sed 's/^/  /'
  sleep 2.5
}

# ── the service, a bucket, two paths ─────────────────────────────────────────
say "odu web: one service, and the cache it serves."
cmd "odu web --background"
"$ODU" web --background 2>&1 | grep -E "started|http"; sleep 1.5

cmd "odu surface cache bucket_create --input '{…\"name\":\"main\",\"retentionDays\":90}' --json"
"$ODU" surface cache bucket_create --input "$(admin '"name":"main","public":true,"retentionDays":90')" \
  --json | "$JQ" -r '"  \(.name): \(.retentionDays)d retention"'
TOKEN=$("$ODU" surface cache token_mint --input "$(admin '"bucket":"main","scope":"write"')" \
  --json | "$JQ" -r .token)
sleep 1

say "Two paths, pushed with a write token."
for name in release-app scratch-build; do
  printf 'kept-by demo: %s\n' "$name" > "$ROOT/$name"
done
APP=$(nix store add-file --store "$BUILDER" "$ROOT/release-app")
SCRATCH=$(nix store add-file --store "$BUILDER" "$ROOT/scratch-build")
cmd "odu cache push main $APP $SCRATCH"
NIX_REMOTE="$BUILDER" ODU_CACHE_TOKEN="$TOKEN" "$ODU" cache push main "$APP" "$SCRATCH" 2>&1 \
  | grep -vE '^$' | tail -2
sleep 1

say "Pin the first one."
cmd "odu surface cache pin_create --input '{…\"name\":\"release\",\"paths\":[\"$APP\"]}' --json"
"$ODU" surface cache pin_create --input "$(admin '"bucket":"main","name":"release","paths":["'"$APP"'"]')" \
  --json | "$JQ" -r '"  pinned \(.name): \(.rootPaths | length) path"'
sleep 1

# ── what keeps each path ─────────────────────────────────────────────────────
say "Why is each path still here, and when does it go?"
kept_by

say "Zero days: keep only what a reference or a pin holds."
cmd "odu surface cache bucket_retention --input '{…\"retentionDays\":0}' --json"
"$ODU" surface cache bucket_retention --input "$(admin '"bucket":"main","retentionDays":0')" \
  --json | "$JQ" -r '"  \(.name): \(.retentionDays)d retention"'
sleep 1
kept_by

say "The column is the collector's own rule: the dry run takes exactly the 'nothing' path."
cmd "odu surface cache gc_plan --input '{…\"bucket\":\"main\"}' --json"
"$ODU" surface cache gc_plan --input "$(admin '"bucket":"main"')" --json \
  | "$JQ" -r '.buckets[] | "  would take \(.evicted): \(.paths | map(.storePath | sub("^/nix/store/[a-z0-9]+-"; "")) | join(", "))"'
sleep 3
