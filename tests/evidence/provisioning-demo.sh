#!/usr/bin/env bash
# Reproducible terminal evidence for "a run you can watch before it has lanes"
# (PR #85, issue #84). Recorded with asciinema, rendered to a gif with agg —
# see .agency/do.md → "PR evidence".
#
# The window under demonstration is the one between `odu run` starting and its
# first lane existing: the coordinator holds the checkout and is claiming a
# machine, which on a cold host is minutes of `nix copy`. Before #84 the socket
# came up only after the claim resolved, so for all of it `odu status` said
# "no run in progress in this checkout" — the same words it uses for a run that
# died or never started.
#
# Making that window deterministic without a cold host: this machine is used as
# a REAL remote venue (its hostname is not isLocalHost, so odu dials ssh and
# takes a flock), and the demo occupies that flock first — exactly what a
# concurrent run would do. The new run then queues in the claim for as long as
# we hold it, which is the same "exists, has no lanes" state a slow closure copy
# produces, reached in one second instead of ten minutes.
#
# Requires: passwordless `ssh $USER@$(hostname -s)` and odu's Nix-built
# odu-runner (the lease is an agent surface RPC; flock ships on the runner
# PATH). Same preconditions as tests/evidence/venue-pools-demo.sh.
#
#   odu=$(nix build .#odu --no-link --print-out-paths)/bin/odu
#   asciinema rec --headless --window-size 92x26 -i 2 --overwrite \
#     -c "bash tests/evidence/provisioning-demo.sh $odu $PWD" /tmp/provisioning.cast
#   agg --speed 1.3 --theme asciinema --font-size 22 /tmp/provisioning.cast provisioning.gif
set -u
ODU="$1"   # path to the odu binary
WT="$2"    # the odu checkout (source of the fixture justfile)

VENUE="$(whoami)@$(hostname | cut -d. -f1)"
SYS="$(nix eval --impure --raw --expr builtins.currentSystem)"
export ODU_HOSTS="$(mktemp -d)/hosts.json"
printf '{"%s":["%s"]}' "$SYS" "$VENUE" > "$ODU_HOSTS"

# The venue lock is the AGENT's, not this shell's: odu-runner resolves it from
# its own `ODU_LEASE_LOCK`/default on the box being claimed, and `odu run`
# passes no override. So a private path here would be a lock nobody contends
# for, and the run would sail straight past the hold this demo is built on.
# Hold the real one. Safe because this is the same machine, the hold is seconds,
# and `release_venue` runs from an EXIT trap.
LOCK="/tmp/odu.lease"

drop_lock() {
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$VENUE" \
    "rm -f $(printf %q "$LOCK") $(printf %q "$LOCK.holder")" >/dev/null 2>&1 || true
}
drop_lock

D=$(mktemp -d /tmp/odu-provisioning-demo-XXXX)
# A real origin the lane can fetch the pushed SHA from — the venue is this same
# machine, so a bare repo on disk is a genuine remote for it. Without one the
# lane's `_ci-setup` dies on the fetch and the demo ends on a red herring.
ORIGIN="$D.origin"
git init -q --bare "$ORIGIN"
cp "$WT/tests/e2e/fixtures/pass/justfile" "$D/"
( cd "$D" && git init -q && git add -A &&
  git -c user.email=a@b.c -c user.name=x commit -qm pass &&
  git remote add origin "file://$ORIGIN" &&
  git push -q origin HEAD:refs/heads/main \
) >/dev/null 2>&1
cd "$D"

P='\033[1;32m$\033[0m'                                   # green prompt
say() { printf "\033[2;37m# %s\033[0m\n" "$1"; sleep 1.4; }
cmd() { printf "$P %s\n" "$1"; sleep 0.7; }

hold_venue() {
  local since_ms holder_body
  since_ms=$(($(date +%s) * 1000))
  holder_body="ci@builder|a1b2c3d#7|${since_ms}"
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$VENUE" \
    "exec 9>$(printf %q "$LOCK") && flock -n 9 && \\
     printf '%s\\n' $(printf %q "$holder_body") >$(printf %q "$LOCK.holder") && \\
     sleep 300" >/dev/null 2>&1 &
  HOLD_PID=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if "$ODU" hosts 2>/dev/null | grep -q busy; then return 0; fi
    sleep 0.3
  done
  return 1
}

release_venue() {
  if [[ -n "${HOLD_PID:-}" ]]; then
    kill "$HOLD_PID" 2>/dev/null || true
    wait "$HOLD_PID" 2>/dev/null || true
    HOLD_PID=
  fi
  drop_lock
}

cleanup() {
  [[ -n "${RUN_PID:-}" ]] && kill "$RUN_PID" 2>/dev/null
  release_venue
  rm -rf "$D" "$(dirname "$ODU_HOSTS")"
}
trap cleanup EXIT

clear
say "A machine has to be claimed before a run has any lane to put work on."
say "Something else is holding this one right now:"
hold_venue || true
cmd "odu hosts"
"$ODU" hosts; sleep 2.4

say "Start a run anyway. It queues in the claim — no lane exists yet."
cmd "odu run --no-strict --no-post --linger &"
"$ODU" run --no-strict --no-post --linger >/dev/null 2>&1 &
RUN_PID=$!
# The socket now comes up BEFORE the claim, so it is dialable within a moment.
for _ in $(seq 1 40); do
  "$ODU" status >/dev/null 2>&1 && break
  sleep 0.25
done
sleep 1.6

say "Before #84 this is where 'odu status' said: no run in progress."
say "Now it says what the run is actually doing:"
cmd "odu status"
"$ODU" status; sleep 3.4

say "…and again a few seconds later — the clock is the claim's own:"
sleep 4
cmd "odu status"
"$ODU" status; sleep 3.2

say "Machine-readable, for an agent driving the run:"
cmd "odu status -o json | jq .run"
"$ODU" status -o json | jq .run; sleep 3.4

say "The claim narrates itself into the lane's _ci-setup log:"
cmd "odu logs _ci-setup@$SYS"
"$ODU" logs "_ci-setup@$SYS" | tail -6; sleep 3.2

say "'odu wait' blocks on it too, instead of reporting nothing to wait for."
say "Now the other holder finishes and the lock frees:"
release_venue
sleep 0.6
cmd "# (holder exits → ssh closes → flock drops)"

# The queued claim polls every 5s; give it a poll plus the lane handshake.
for _ in $(seq 1 60); do
  "$ODU" status -o json 2>/dev/null | jq -e '.run.phase == "lanes"' >/dev/null 2>&1 && break
  sleep 0.5
done
sleep 0.8

say "The roster resolves, and the same command now reports the lane:"
cmd "odu status -o json | jq .run"
"$ODU" status -o json | jq .run; sleep 3.6

say "One socket, live from the moment the run existed."
sleep 1.8

"$ODU" cancel >/dev/null 2>&1 || true
sleep 0.8
