#!/usr/bin/env bash
# Reproducible terminal evidence for juspay/odu#87 — a lane node's durable log
# losing its end. Recorded with asciinema and rendered to a gif with agg; see
# .agency/do.md → "PR evidence". Drives the real odu binary against a throwaway
# noisy fixture, pinned to a localhost lane.
#
#   odu=$(nix build .#odu --no-link --print-out-paths)/bin/odu
#   asciinema rec --headless --window-size 100x24 -i 2 --overwrite \
#     -c "bash tests/evidence/log-tail-demo.sh $odu $PWD" /tmp/logtail.cast
#   agg --speed 1.3 --theme asciinema --font-size 22 /tmp/logtail.cast logtail.gif
set -u
ODU="$1"   # path to the odu binary (carries ODU_RUNNER_FLAKE baked in)
WT="$2"    # the odu checkout (source of the fixture justfile)

# Pin this machine's platform to an explicit localhost lane. A bare/empty hosts
# config is refused (juspay/odu#46), so name the lane for the current system.
export ODU_HOSTS="$(mktemp -d)/hosts.json"
PLAT="$(nix eval --impure --raw --expr builtins.currentSystem)"
printf '{"%s":"localhost"}' "$PLAT" > "$ODU_HOSTS"
D=$(mktemp -d /tmp/odu-demo-XXXX)
# A plain consumer: just a justfile, no flake. The runner comes from the odu
# binary's baked ODU_RUNNER_FLAKE, not this repo (see issue #30).
cp "$WT/tests/e2e/fixtures/noisy/justfile" "$D/"
( cd "$D" && git init -q && git add -A &&
  git -c user.email=a@b.c -c user.name=x commit -qm fix ) >/dev/null 2>&1
cd "$D"

P='\033[1;32m$\033[0m'                                   # green prompt
say() { printf "\033[2;37m# %s\033[0m\n" "$1"; sleep 1.4; }
cmd() { printf "$P %s\n" "$1"; sleep 0.7; }

clear
say "This recipe prints 200,000 lines and then says how it went."
cmd "tail -3 justfile"
tail -3 justfile; sleep 2.2

say "The last two lines are the only ones anybody actually reads."
say "Run it under odu:"
cmd "odu run --no-strict"
"$ODU" run --no-strict 2>&1 | tail -6; sleep 2

SHA=$(git rev-parse --short=7 HEAD)
LOG=".ci/$SHA/$PLAT/noisy.log"

say "The durable log odu leaves behind:"
cmd "wc -l $LOG"
wc -l "$LOG"; sleep 1.8

say "Before #87 this stopped mid-recipe — the head survived, the summary never"
say "arrived, and a red node was undiagnosable from its own log."
cmd "tail -2 $LOG"
tail -2 "$LOG"; sleep 2.6

say "Every line is there, ending where the recipe ended:"
cmd "grep -c '^noisy line' $LOG"
grep -c '^noisy line' "$LOG"; sleep 2.2

say "And if a log ever IS cut short, it now says so in its own last line"
say "rather than just stopping — no truncation notice here, because nothing"
say "was lost."
cmd "grep -c 'log truncated' $LOG"
grep -c 'log truncated' "$LOG" || true; sleep 2.6
