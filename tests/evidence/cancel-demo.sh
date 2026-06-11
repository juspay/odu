#!/usr/bin/env bash
# Reproducible terminal evidence for cancel / supersede. Recorded with asciinema
# and rendered to a gif with agg — see .agency/do.md → "PR evidence". Drives the
# real odu binary against a throwaway sleep fixture, pinned to a localhost lane.
#
#   odu=$(nix build .#odu --no-link --print-out-paths)/bin/odu
#   asciinema rec --headless --window-size 92x20 -i 2 --overwrite \
#     -c "bash tests/evidence/cancel-demo.sh $odu $PWD" /tmp/cancel.cast
#   agg --speed 1.3 --theme asciinema --font-size 22 /tmp/cancel.cast cancel.gif
set -u
ODU="$1"   # path to the odu binary
WT="$2"    # the odu checkout (for the fixture's flake ref)

export ODU_HOSTS="$(mktemp -d)/hosts.json"; echo '{}' > "$ODU_HOSTS"
D=$(mktemp -d /tmp/odu-demo-XXXX)
cp "$WT/tests/e2e/fixtures/sleep/justfile" "$D/"
sed "s|__ODU_FLAKE__|path:$WT|" "$WT/tests/e2e/fixtures/_flake.nix.in" > "$D/flake.nix"
( cd "$D" && git init -q && git add -A &&
  git -c user.email=a@b.c -c user.name=x commit -qm fix ) >/dev/null 2>&1
cd "$D"

P='\033[1;32m$\033[0m'                                   # green prompt
say() { printf "\033[2;37m# %s\033[0m\n" "$1"; sleep 1.4; }
cmd() { printf "$P %s\n" "$1"; sleep 0.7; }

clear
say "A pipeline is running — and there was no way to stop it."
( "$ODU" run --no-strict >/dev/null 2>&1 & ); sleep 18

cmd "odu status"
"$ODU" status; sleep 1.6

say "Call it off from any other shell — no pkill, no waiting it out:"
cmd "odu cancel"
"$ODU" cancel; sleep 1.2
cmd "odu status"
"$ODU" status || true; sleep 2

say "'supersede' is cancel + start in one — stop this, run the fixed commit:"
( "$ODU" run --no-strict >/dev/null 2>&1 & ); sleep 18
cmd "odu run --no-strict             # the one-run lock refuses a second run"
"$ODU" run --no-strict 2>&1 | tail -1; sleep 1.8
cmd "odu run --no-strict --supersede"
( "$ODU" run --no-strict --supersede >/dev/null 2>&1 & ); sleep 16
cmd "odu status                       # the new run took over"
"$ODU" status; sleep 2.2
"$ODU" cancel >/dev/null 2>&1

rm -rf "$D" "$(dirname "$ODU_HOSTS")"
