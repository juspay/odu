#!/usr/bin/env bash
# Reproducible terminal evidence for venue pools / machine lease (PR #56,
# issue #54). Recorded with asciinema, rendered to a gif with agg — see
# .agency/do.md → "PR evidence". Drives the real odu binary against a throwaway
# fixture; the "venue" is this machine reached over ssh (not the localhost
# short-circuit) so flock-over-ssh lease, `odu hosts`, and `--no-wait` are real.
#
# Requires: passwordless `ssh $USER@$(hostname -s)` (or bare hostname) and
# odu's Nix-built odu-runner (lease is an agent surface RPC; flock ships on
# the runner PATH). The synthetic "other agent holds the lock" uses host
# flock only to occupy the lock file for the demo.
#
#   odu=$(nix build .#odu --no-link --print-out-paths)/bin/odu
#   asciinema rec --headless --window-size 92x22 -i 2 --overwrite \
#     -c "bash tests/evidence/venue-pools-demo.sh $odu $PWD" /tmp/venue-pools.cast
#   agg --speed 1.3 --theme asciinema --font-size 22 /tmp/venue-pools.cast venue-pools.gif
set -u
ODU="$1"   # path to the odu binary
WT="$2"    # the odu checkout (source of the fixture justfile)

# Self as a remote venue: hostname is NOT isLocalHost, so odu dials ssh+flock.
VENUE="$(whoami)@$(hostname | cut -d. -f1)"
SYS="$(nix eval --impure --raw --expr builtins.currentSystem)"
export ODU_HOSTS="$(mktemp -d)/hosts.json"
# Private lock path so this demo never contends with a real production lease.
export ODU_LEASE_LOCK="/tmp/odu.lease.evidence-$$"
# Pool-of-list form (a plain string is still a pool of one).
printf '{"%s":["%s"]}' "$SYS" "$VENUE" > "$ODU_HOSTS"

# Clean any leftover lock from a prior interrupted demo on this path.
ssh -o BatchMode=yes -o ConnectTimeout=5 "$VENUE" \
  "rm -f $(printf %q "$ODU_LEASE_LOCK") $(printf %q "$ODU_LEASE_LOCK.holder")" \
  >/dev/null 2>&1 || true

D=$(mktemp -d /tmp/odu-venue-demo-XXXX)
cp "$WT/tests/e2e/fixtures/pass/justfile" "$D/"
# Remote lanes need an origin to fetch from (precheck before lease). A fake
# github.com remote is enough to pass that gate; we never get that far under
# --no-wait on a saturated pool.
( cd "$D" && git init -q && git add -A &&
  git -c user.email=a@b.c -c user.name=x commit -qm pass &&
  git remote add origin https://github.com/example/odu-venue-evidence.git \
) >/dev/null 2>&1
cd "$D"

P='\033[1;32m$\033[0m'                                   # green prompt
say() { printf "\033[2;37m# %s\033[0m\n" "$1"; sleep 1.4; }
cmd() { printf "$P %s\n" "$1"; sleep 0.7; }

# Hold the remote flock the same way a concurrent odu run would (holder file
# + exclusive flock). Background ssh keeps the fd open until we kill it.
hold_venue() {
  local since_ms holder_body
  since_ms=$(($(date +%s) * 1000))
  holder_body="srid@laptop|e9f0a1b#1|${since_ms}"
  # stdout discarded so "HELD" does not leak into the asciinema recording.
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$VENUE" \
    "exec 9>$(printf %q "$ODU_LEASE_LOCK") && flock -n 9 && \
     printf '%s\\n' $(printf %q "$holder_body") >$(printf %q "$ODU_LEASE_LOCK.holder") && \
     sleep 300" >/dev/null 2>&1 &
  HOLD_PID=$!
  # Wait until the probe sees busy (or give up).
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
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$VENUE" \
    "rm -f $(printf %q "$ODU_LEASE_LOCK") $(printf %q "$ODU_LEASE_LOCK.holder")" \
    >/dev/null 2>&1 || true
}

clear
say "hosts.json can list several machines per platform — a venue pool:"
cmd "cat \$ODU_HOSTS"
cat "$ODU_HOSTS"; echo; sleep 1.8

say "odu hosts probes free/busy without acquiring (lock is on the box):"
cmd "odu hosts"
"$ODU" hosts; sleep 2.2

say "Another agent is already running CI on that machine — it holds the flock:"
cmd "# (concurrent run holds /tmp/odu.lease over ssh + heartbeats)"
hold_venue || true
sleep 0.8
cmd "odu hosts"
"$ODU" hosts; sleep 2.4

say "A new run with --no-wait fails immediately instead of queueing:"
cmd "odu run --no-strict --no-wait"
set +e
"$ODU" run --no-strict --no-wait --no-post
set -e
sleep 2.2

say "When the holder finishes, the lock frees — no daemon, no cleanup race:"
cmd "# (prior run exits → ssh closes → flock drops)"
release_venue
sleep 0.6
cmd "odu hosts"
"$ODU" hosts; sleep 2.8

say "Pool-of-one string form still works; localhost is never leased."
sleep 1.6

release_venue
rm -rf "$D" "$(dirname "$ODU_HOSTS")"
# Best-effort: remove lock path we created (may already be gone).
ssh -o BatchMode=yes -o ConnectTimeout=5 "$VENUE" \
  "rm -f $(printf %q "$ODU_LEASE_LOCK") $(printf %q "$ODU_LEASE_LOCK.holder")" \
  >/dev/null 2>&1 || true
