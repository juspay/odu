#!/usr/bin/env bash
# Evidence for per-node / per-platform cancel (juspay/odu#68).
# Drives the real odu binary against a sleep fixture with --linger so a
# mid-run cancel can land, then shows the cancelled status and that the
# coordinator stays up for a full-run cancel afterwards.
#
#   odu=$(nix build .#odu --no-link --print-out-paths)/bin/odu
#   asciinema rec --headless --window-size 92x20 -i 2 --overwrite \
#     -c "bash tests/evidence/node-cancel-demo.sh $odu $PWD" /tmp/node-cancel.cast
set -u
ODU="$1"
WT="$2"

export ODU_HOSTS="$(mktemp -d)/hosts.json"
printf '{"%s":"localhost"}' "$(nix eval --impure --raw --expr builtins.currentSystem)" > "$ODU_HOSTS"
D=$(mktemp -d /tmp/odu-node-cancel-XXXX)
cp "$WT/tests/e2e/fixtures/sleep/justfile" "$D/"
( cd "$D" && git init -q && git add -A &&
  git -c user.email=a@b.c -c user.name=x commit -qm fix ) >/dev/null 2>&1
cd "$D"

P='\033[1;32m$\033[0m'
say() { printf "\033[2;37m# %s\033[0m\n" "$1"; sleep 1.2; }
cmd() { printf "$P %s\n" "$1"; sleep 0.6; }

clear
say "Start a long-running pipeline with --linger (keeps the coordinator up)."
( "$ODU" run --no-strict --linger >/dev/null 2>&1 & ); sleep 14

cmd "odu status"
"$ODU" status 2>&1 || true; sleep 1.4

# Pick the first running node id if any, else the first non-ok id.
NODE=$("$ODU" status -o json 2>/dev/null | node -e '
  let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
    try {
      const j=JSON.parse(s);
      const nodes=j.nodes||[];
      const run=nodes.find(n=>n.status==="running")||nodes.find(n=>n.status==="pending")||nodes[0];
      process.stdout.write(run?run.id:"");
    } catch { process.stdout.write(""); }
  });
')

if [ -n "$NODE" ]; then
  say "Cancel one node mid-run — the rest of the run keeps the coordinator alive:"
  cmd "odu cancel $NODE"
  "$ODU" cancel "$NODE"; sleep 1.4
  cmd "odu status"
  "$ODU" status 2>&1 || true; sleep 1.8
else
  say "(no live node id resolved — showing status only)"
  "$ODU" status 2>&1 || true; sleep 1
fi

say "Full-run cancel still tears the coordinator down when you are done:"
cmd "odu cancel"
"$ODU" cancel; sleep 1.2
cmd "odu status"
"$ODU" status 2>&1 || true; sleep 1.5

rm -rf "$D" "$(dirname "$ODU_HOSTS")"
