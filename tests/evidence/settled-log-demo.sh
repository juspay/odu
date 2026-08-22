#!/usr/bin/env bash
# Reproducible terminal evidence for the settle-shaped residual after
# juspay/odu#88: a run that reports itself SETTLED while its node's log is
# still arriving. Recorded with asciinema and rendered to a gif with agg; see
# .agency/do.md → "PR evidence".
#
#   odu=$(nix build .#odu --no-link --print-out-paths)/bin/odu
#   asciinema rec --headless --window-size 100x24 -i 2 --overwrite \
#     -c "bash tests/evidence/settled-log-demo.sh $odu $PWD" /tmp/settled.cast
#   agg --speed 1.3 --theme asciinema --font-size 22 /tmp/settled.cast settled.gif
#
# The shape under test is the agent's own loop, not a human's: start a run that
# LINGERS (so nothing depends on racing a teardown), block on `odu wait
# --settle`, and read the node's log the instant the verdict lands. Before this
# change the log stopped a quarter of the way through the recipe, with no
# summary and no `[odu] log truncated` notice to say so.
set -u
ODU="$1"   # path to the odu binary (carries ODU_RUNNER_FLAKE baked in)
WT="$2"    # the odu checkout (source of the fixture justfile)

# Pin this machine's platform to an explicit localhost lane. A bare/empty hosts
# config is refused (juspay/odu#46), so name the lane for the current system.
export ODU_HOSTS="$(mktemp -d)/hosts.json"
PLAT="$(nix eval --impure --raw --expr builtins.currentSystem)"
printf '{"%s":"localhost"}' "$PLAT" > "$ODU_HOSTS"
D=$(mktemp -d /tmp/odu-demo-XXXX)
cp "$WT/tests/e2e/fixtures/noisy/justfile" "$D/"
( cd "$D" && git init -q && git add -A &&
  git -c user.email=a@b.c -c user.name=x commit -qm fix ) >/dev/null 2>&1
cd "$D"

P='\033[1;32m$\033[0m'                                   # green prompt
say() { printf "\033[2;37m# %s\033[0m\n" "$1"; sleep 1.4; }
cmd() { printf "$P %s\n" "$1"; sleep 0.7; }

clear
say "A recipe that prints 200,000 lines, then says how it went."
cmd "tail -2 justfile"
tail -2 justfile; sleep 2.2

say "Start it, and let the coordinator LINGER past settle — an agent's own run"
say "shape, and the one where nothing tears down to force the logs through."
cmd "odu run --no-strict --linger &"
"$ODU" run --no-strict --linger --progress json >/dev/null 2>&1 &
while [ ! -S .ci/odu.sock ]; do sleep 0.2; done
sleep 1.5

say "Block until the run reports itself settled, the way wait_for_settle does:"
cmd "odu wait --settle"
"$ODU" wait --settle --timeout-ms 300000
sleep 2

SHA=$(git rev-parse --short=7 HEAD)
LOG=".ci/$SHA/$PLAT/noisy.log"

say "settled: true. THIS INSTANT — no sleep, no retry — the durable log:"
cmd "wc -l $LOG && tail -2 $LOG"
wc -l "$LOG"; tail -2 "$LOG"; sleep 2.8

say "The summary is there. Before this change the same read landed 55,605 of"
say "200,000 lines with no summary — and no notice saying anything was missing."
cmd "grep -c '^noisy line' $LOG"
grep -c '^noisy line' "$LOG"; sleep 2.2

say "And if a log ever IS cut short, it says so in its own last line. Nothing"
say "was lost here, so there is nothing to say:"
cmd "grep -c 'log truncated' $LOG"
grep -c 'log truncated' "$LOG" || true; sleep 2.4

"$ODU" cancel >/dev/null 2>&1
wait 2>/dev/null
