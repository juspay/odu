#!/usr/bin/env bash
# Reproducible terminal evidence for the opentui live view (juspay/odu#73).
# Recorded with asciinema and rendered to a gif with agg — see .agency/do.md →
# "PR evidence". Drives the real odu binary against a throwaway fixture pinned
# to a localhost lane.
#
# What it has to show, because these are the claims the PR makes:
#   1. the run takes the whole terminal — matrix, events lane, log pane;
#   2. a red node lands in the events lane INSIDE the frame, not in scrollback;
#   3. on exit the shell history above the run is exactly where it was, with
#      one verdict line added. That is the whole point: attach stops scrolling.
#
#   odu=$(nix build .#odu --no-link --print-out-paths)/bin/odu
#   asciinema rec --headless --window-size 92x24 -i 2 --overwrite \
#     -c "bash tests/evidence/tui-demo.sh $odu $PWD" /tmp/tui.cast
#   agg --speed 1.3 --theme asciinema --font-size 22 /tmp/tui.cast tui.gif
set -u
ODU="$1"   # path to the odu binary (carries ODU_RUNNER_FLAKE baked in)
WT="$2"    # the odu checkout (unused here — the fixture is written inline)
: "$WT"

# Pin this machine's platform to an explicit localhost lane. A bare/empty hosts
# config is refused (juspay/odu#46), so name the lane for the current system.
export ODU_HOSTS="$(mktemp -d)/hosts.json"
printf '{"%s":"localhost"}' "$(nix eval --impure --raw --expr builtins.currentSystem)" > "$ODU_HOSTS"

D=$(mktemp -d /tmp/odu-tui-demo-XXXX)
# A DAG paced for a recording: long enough that the spinners, the elapsed
# clocks and the streaming log pane are legible, with one node that goes red so
# the events lane has something to hold.
cat > "$D/justfile" <<'JUSTFILE'
[parallel]
[metadata("ci")]
default: fmt unit e2e

fmt:
    @echo "treefmt: traversed 214 files"; sleep 3; echo "formatted"

unit:
    @for i in $(seq 1 6); do echo "  ✓ suite $i passed"; sleep 1; done

e2e:
    @echo "RUN  v4.1.0"; sleep 2; \
     for i in $(seq 1 20); do printf "\rbuilding [%-20s] %d%%" "$(printf '#%.0s' $(seq 1 $i))" $((i*5)); sleep 0.3; done; \
     echo; echo "  ✗ matrix.e2e.ts > fan-in keeps lane order"; echo "AssertionError: expected order to match"; exit 1
JUSTFILE
( cd "$D" && git init -q && git add -A &&
  git -c user.email=a@b.c -c user.name=x commit -qm fixture ) >/dev/null 2>&1
cd "$D"

P='\033[1;32m$\033[0m'                                   # green prompt
say() { printf "\033[2;37m# %s\033[0m\n" "$1"; sleep 1.6; }
cmd() { printf "$P %s\n" "$1"; sleep 0.8; }

clear
say "An ordinary shell session — note what is on screen here."
cmd "git log --oneline -1"
git log --oneline -1; sleep 0.6
cmd "ls"
ls; sleep 1.8

say "Now a live run. It takes the terminal: matrix, events, and the focused log."
say "The log pane is a real VT — watch the progress bar redraw in place."
cmd "odu run --no-strict"
"$ODU" run --no-strict || true
sleep 1

say "Back in the shell — and the history above is exactly where it was."
say "The run left one verdict line. Nothing else touched your scrollback."
sleep 4
