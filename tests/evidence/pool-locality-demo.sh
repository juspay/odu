#!/usr/bin/env bash
# Reproducible terminal evidence for lazy pool-locality (PR #67, issue #66).
# Recorded with asciinema, rendered to a gif with agg — see .agency/do.md →
# "PR evidence". Drives the real odu binary against a throwaway fixture with a
# hosts file whose x86_64-linux pool illegally mixes localhost with remotes:
# the shape that used to kill EVERY run in the checkout at config-load time.
#
# Nothing here leases or dials: every run is refused or resolved before odu
# reaches a machine, which is the point — the difference this PR makes is
# visible before the first packet.
#
#   odu=$(nix build .#odu --no-link --print-out-paths)/bin/odu
#   asciinema rec --headless --window-size 100x24 -i 2 --overwrite \
#     -c "bash tests/evidence/pool-locality-demo.sh $odu $PWD" /tmp/pool-locality.cast
#   agg --speed 1.3 --theme asciinema --font-size 22 /tmp/pool-locality.cast pool-locality.gif
set -u
ODU="$1"   # path to the odu binary
WT="$2"    # the odu checkout (source of the fixture justfile)

export ODU_HOSTS="$(mktemp -d)/hosts.json"
cat > "$ODU_HOSTS" <<'JSON'
{
  "x86_64-linux": ["ci-1", "ci-2", "localhost"],
  "aarch64-darwin": ["rasam"]
}
JSON

D=$(mktemp -d /tmp/odu-locality-demo-XXXX)
cp "$WT/tests/e2e/fixtures/pass/justfile" "$D/"
( cd "$D" && git init -q && git add -A &&
  git -c user.email=a@b.c -c user.name=x commit -qm pass \
) >/dev/null 2>&1
cd "$D"

P='\033[1;32m$\033[0m'                                   # green prompt
say() { printf "\033[2;37m# %s\033[0m\n" "$1"; sleep 1.4; }
cmd() { printf "$P %s\n" "$1"; sleep 0.7; }

clear
say "A hosts file whose linux pool mixes localhost with remotes — illegal:"
cmd "cat \$ODU_HOSTS"
cat "$ODU_HOSTS"; echo; sleep 2.0

say "BEFORE #66 this killed EVERY run here at config load, whatever it asked for."
say "Now a darwin-only run gets past the pool it never leases:"
cmd "odu run --platform aarch64-darwin --host aarch64-darwin=rasam --no-strict"
"$ODU" run --platform aarch64-darwin --host aarch64-darwin=rasam --no-strict 2>&1 | head -3
say "^ that is the NEXT gate talking. Host resolution succeeded."
sleep 1.6

say "Same for a selector naming one platform — no --platform, no --host at all:"
cmd "odu run alpha@aarch64-darwin --no-strict"
"$ODU" run alpha@aarch64-darwin --no-strict 2>&1 | head -3
sleep 2.4

say "The rule is NARROWED, not deleted — lease that linux pool and it refuses:"
cmd "odu run --platform x86_64-linux --no-strict"
"$ODU" run --platform x86_64-linux --no-strict 2>&1 | head -3
sleep 2.8

say "A pin stands alone: one host is pure by construction, so it resolves:"
cmd "odu run --platform x86_64-linux --host x86_64-linux=ci-9 --no-strict"
"$ODU" run --platform x86_64-linux --host x86_64-linux=ci-9 --no-strict 2>&1 | head -3
sleep 2.4

say "odu hosts never leases, so it lists rather than refuses — but it WARNS:"
cmd "odu hosts"
timeout 10 "$ODU" hosts 2>&1 | head -3
sleep 3.0

rm -rf "$D"
