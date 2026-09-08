#!/usr/bin/env bash
# Packaged, private-world bundle acceptance. Usage: bash .../dirty-remote-demo.sh ODU REPO
set -euo pipefail
odu="$1"
repo="$2"
world=$(mktemp -d /tmp/odu-dirty-demo-XXXXXX)
export ODU_STATE_DIR="$world/state"
export ODU_HOSTS="$world/hosts.json"
export ODU_WEB_ORIGIN="http://127.0.0.1:$((22000 + $$ % 10000))"
export ODU_SNAPSHOT_TRANSPORT=always
system=$(nix eval --impure --raw --expr builtins.currentSystem)
printf '{"%s":"localhost"}\n' "$system" > "$ODU_HOSTS"
mkdir -p "$world/repo" "$ODU_STATE_DIR"
cp "$repo"/tests/e2e/fixtures/dirty/* "$world/repo/"
cleanup() {
  service=$("$odu" surface get service 2>/dev/null) || service='{}'
  pid=$(printf '%s' "$service" | jq -r '.identity.pid // empty')
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
  rm -rf "$world"
}
trap cleanup EXIT
cd "$world/repo"
git init -q
git add -A
git -c user.name=demo -c user.email=demo@localhost commit -qm base
git clone -q --bare . "$world/origin-$(basename "$world").git"
git remote add origin "file://$world/origin-$(basename "$world").git"
git fetch -q origin
base=$(git rev-parse HEAD)
say() { printf '\n\033[1;36m# %s\033[0m\n' "$*"; }
cmd() { printf '\033[1;32m$ %s\033[0m\n' "$*"; }
run_case() {
  expected="$1"
  cmd 'odu run --no-strict -o json'
  code=0
  "$odu" run --no-strict -o json > "$world/answer.json" || code=$?
  test "$code" = "$expected"
  jq '{runId,sha,contentSha,dirty,settled,passed}' "$world/answer.json"
  run_id=$(jq -r .runId "$world/answer.json")
  rg 'captured in' "$ODU_STATE_DIR/runs/$run_id/coordinator.log"
  # This fixture runs each node exactly once; the public CLI takes ONE log key.
  key="$run_id/_ci-setup~40$system/1"
  cmd "odu logs $key"
  "$odu" logs "$key" > "$world/setup.log"
  sed -n '/uploading snapshot/p;/snapshot .*uploaded/p;/already on /p;/fetched from bundle/p;/already in object cache/p;/snapshot .* = HEAD /p;/^[[:space:]]*[ADM][[:space:]]/p' "$world/setup.log"
}
say 'Uncommitted edit, new file and deletion; real bundle wire on localhost'
printf 'red\n' > marker.txt
printf 'new\n' > new.txt
rm gone.txt
git status --short
run_case 1
red=$(jq -r .contentSha "$world/answer.json")
say 'Fix the edit; green must carry a different contentSha'
printf 'green\n' > marker.txt
run_case 0
green=$(jq -r .contentSha "$world/answer.json")
test "$green" != "$red"
say 'Repeat without edits: identical contentSha, cache hit'
run_case 0
test "$(jq -r .contentSha "$world/answer.json")" = "$green"
rg 'already in object cache' "$world/setup.log"
cmd 'odu history list'
"$odu" history list
test "$(git rev-parse HEAD)" = "$base"
test -z "$(git diff --cached --name-only)"
say 'HEAD and index unchanged; nothing committed or pushed by odu'
git status --short

say 'Local-only, no origin, one-byte transport ceiling: snapshot still runs'
service=$("$odu" surface get service)
kill "$(printf '%s' "$service" | jq -r .identity.pid)"
# A fresh private daemon takes the changed launch environment.
export ODU_STATE_DIR="$world/local-state"
mkdir -p "$ODU_STATE_DIR"
unset ODU_SNAPSHOT_TRANSPORT
export ODU_SNAPSHOT_MAX_BYTES=1
git remote remove origin
run_case 0
test "$(jq -r .contentSha "$world/answer.json")" = "$green"
say 'Local snapshot preserved identical content and shipped zero bundle bytes'
