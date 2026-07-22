#!/usr/bin/env bash
# Reproducible terminal evidence for `odu protect` platform enumeration
# (PR #53, issue #52). Recorded with asciinema, rendered to a gif with agg —
# see .agency/do.md → "PR evidence". Drives the real odu binary against a
# throwaway fixture; protect --dry-run never dials a host, which is the point.
#
#   odu=$(nix build .#odu --no-link --print-out-paths)/bin/odu
#   asciinema rec --headless --window-size 92x26 -i 2 --overwrite \
#     -c "bash tests/evidence/protect-demo.sh $odu $PWD" /tmp/protect.cast
#   agg --speed 1.3 --theme asciinema --font-size 22 /tmp/protect.cast protect.gif
set -u
ODU="$1"   # path to the odu binary
WT="$2"    # the odu checkout (source of the fixture justfile)

# An EMPTY hosts config — the #52 scenario: this machine can dial nothing.
export ODU_HOSTS="$(mktemp -d)/hosts.json"
printf '{}' > "$ODU_HOSTS"
D=$(mktemp -d /tmp/odu-protect-demo-XXXX)
cp "$WT/tests/e2e/fixtures/pass/justfile" "$D/"
( cd "$D" && git init -q && git add -A &&
  git -c user.email=a@b.c -c user.name=x commit -qm pass ) >/dev/null 2>&1
cd "$D"

P='\033[1;32m$\033[0m'                                   # green prompt
say() { printf "\033[2;37m# %s\033[0m\n" "$1"; sleep 1.4; }
cmd() { printf "$P %s\n" "$1"; sleep 0.7; }

clear
say "This machine's hosts config is EMPTY — it can ssh to nothing:"
cmd "cat \$ODU_HOSTS"
cat "$ODU_HOSTS"; echo; sleep 1.6

say "protect never dials a host, so explicit --platform needs no hosts (#52):"
cmd "odu protect --dry-run --platform x86_64-linux --platform aarch64-darwin"
"$ODU" protect --dry-run --platform x86_64-linux --platform aarch64-darwin
sleep 2.6

say "Unsliced, the set derives from the hosts file — and now SAYS so"
say "(a one-platform machine once silently halved a repo's protection):"
printf '{"x86_64-linux":"ci-box"}' > "$ODU_HOSTS"
cmd "odu protect --dry-run"
"$ODU" protect --dry-run
sleep 3.2

say "A blank --platform value is refused, not fanned out as 'recipe@':"
cmd "odu protect --dry-run --platform ''"
"$ODU" protect --dry-run --platform '' || true
sleep 2.6

rm -rf "$D" "$(dirname "$ODU_HOSTS")"
