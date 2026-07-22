#!/usr/bin/env bash
# Reproducible terminal evidence for #30: a consumer repo with NO flake (it
# re-exports nothing) runs odu green, because the lane runner now comes from
# odu's OWN flake — baked onto the binary as ODU_RUNNER_FLAKE — not the repo
# under test. Recorded with asciinema, rendered with agg — see .agency/do.md.
#
#   odu=$(nix build .#odu --no-link --print-out-paths)/bin/odu
#   asciinema rec --headless --window-size 92x24 -i 2 --overwrite \
#     -c "bash tests/evidence/runner-flake-demo.sh $odu $PWD" /tmp/rf.cast
#   agg --speed 1.3 --theme asciinema --font-size 22 /tmp/rf.cast rf.gif
set -u
ODU="$1"   # path to the odu binary (carries ODU_RUNNER_FLAKE baked in)
WT="$2"    # the odu checkout (source of the fixture justfile)

# Pin this machine's platform to an explicit localhost lane. A bare/empty hosts
# config is refused (juspay/odu#46), so name the lane for the current system.
export ODU_HOSTS="$(mktemp -d)/hosts.json"
printf '{"%s":"localhost"}' "$(nix eval --impure --raw --expr builtins.currentSystem)" > "$ODU_HOSTS"
D=$(mktemp -d /tmp/odu-rf-demo-XXXX)
cp "$WT/tests/e2e/fixtures/pass/justfile" "$D/"
printf '.ci/\n' > "$D/.gitignore"   # so odu's own run output never reads as dirty
( cd "$D" && git init -q && git add -A &&
  git -c user.email=a@b.c -c user.name=x commit -qm pass ) >/dev/null 2>&1
cd "$D"

P='\033[1;32m$\033[0m'                                   # green prompt
say() { printf "\033[2;37m# %s\033[0m\n" "$1"; sleep 1.5; }
cmd() { printf "$P %s\n" "$1"; sleep 0.7; }

clear
say "A plain consumer repo — just a justfile, and no flake at all:"
cmd "ls -A"
ls -A; sleep 1.6
say "It re-exports no odu-runner. Before #30 every lane died here at _ci-setup."
cmd "odu run --no-strict"
"$ODU" run --no-strict; sleep 2.5
say "Green — the lane runner came from odu's OWN flake (baked ODU_RUNNER_FLAKE),"
say "not this repo. A consumer configures nothing."
sleep 2

rm -rf "$D" "$(dirname "$ODU_HOSTS")"
