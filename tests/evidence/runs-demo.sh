#!/usr/bin/env bash
# Reproducible terminal evidence for `odu runs` — the durable run ledger
# (PR #28). Recorded with asciinema, rendered to a gif with agg — see
# .agency/do.md → "PR evidence". Drives the real odu binary against a throwaway
# fixture, pinned to a localhost lane; the run output is hidden so the gif stays
# about the ledger, not the matrix.
#
#   odu=$(nix build .#odu --no-link --print-out-paths)/bin/odu
#   asciinema rec --headless --window-size 92x26 -i 2 --overwrite \
#     -c "bash tests/evidence/runs-demo.sh $odu $PWD" /tmp/runs.cast
#   agg --speed 1.3 --theme asciinema --font-size 22 /tmp/runs.cast runs.gif
set -u
ODU="$1"   # path to the odu binary (carries ODU_RUNNER_FLAKE baked in)
WT="$2"    # the odu checkout (source of the fixture justfile)

# Pin this machine's platform to an explicit localhost lane. A bare/empty hosts
# config is refused (juspay/odu#46), so name the lane for the current system.
export ODU_HOSTS="$(mktemp -d)/hosts.json"
printf '{"%s":"localhost"}' "$(nix eval --impure --raw --expr builtins.currentSystem)" > "$ODU_HOSTS"
D=$(mktemp -d /tmp/odu-runs-demo-XXXX)
# A plain consumer: just a justfile, no flake — the runner comes from the odu
# binary's baked ODU_RUNNER_FLAKE, not this repo (see issue #30).
cp "$WT/tests/e2e/fixtures/pass/justfile" "$D/"
printf '.ci/\n' > "$D/.gitignore"   # so odu's own run output never reads as a dirty tree
( cd "$D" && git init -q && git add -A &&
  git -c user.email=a@b.c -c user.name=x commit -qm pass ) >/dev/null 2>&1
cd "$D"

GIT="git -c user.email=a@b.c -c user.name=x"
P='\033[1;32m$\033[0m'                                   # green prompt
say() { printf "\033[2;37m# %s\033[0m\n" "$1"; sleep 1.4; }
cmd() { printf "$P %s\n" "$1"; sleep 0.7; }

clear
say "odu runs reads the durable ledger off disk — it answers with no run live:"
cmd "odu runs"
"$ODU" runs; sleep 1.8

say "Run CI on this commit (localhost, a fast passing pipeline):"
cmd "odu run --no-strict"
"$ODU" run --no-strict >/dev/null 2>&1; echo "  → green"; sleep 1

say "Run it again — same commit, but a NEW run, not an overwrite:"
cmd "odu run --no-strict"
"$ODU" run --no-strict >/dev/null 2>&1; echo "  → green"; sleep 1

say "Each run is its own record — note the #1 / #2 seq, newest first:"
cmd "odu runs"
"$ODU" runs; sleep 2.6

say "Break the build and commit — a new commit is a new sha:"
cp "$WT/tests/e2e/fixtures/fail/justfile" "$D/justfile"
$GIT commit -aqm fail
cmd "odu run --no-strict          # this one goes red"
"$ODU" run --no-strict >/dev/null 2>&1 || true; echo "  → failed"; sleep 1

say "The ledger spans commits, newest first — sha#seq and outcome:"
cmd "odu runs"
"$ODU" runs; sleep 2.8

say "And as JSON — the rows odu-web and the runs MCP tool consume:"
cmd "odu runs -o json | head -n 24"
"$ODU" runs -o json | head -n 24; sleep 3

rm -rf "$D" "$(dirname "$ODU_HOSTS")"
