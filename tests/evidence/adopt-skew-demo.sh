#!/usr/bin/env bash
# Reproducible terminal evidence for juspay/odu#115: a thin client that cannot
# speak the running daemon's contract now refuses ADOPTION with the upgrade
# sentence and exit 3 — where before it was adopted unchecked and the first
# RPC came back as a bare `undefined` on an exit-1 line.
#
#   old=$(nix build --accept-flake-config github:juspay/odu/4463a1b#odu --no-link --print-out-paths)/bin/odu
#   new=$(nix build .#odu --no-link --print-out-paths)/bin/odu
#   asciinema rec --headless --window-size 92x20 -i 2 --overwrite \
#     -c "bash tests/evidence/adopt-skew-demo.sh $old $new" /tmp/adopt-skew.cast
#   agg --speed 1.3 --theme asciinema --font-size 22 /tmp/adopt-skew.cast adopt-skew.gif
set -u
OLD="$1" # a pre-#114 build — speaks contract 1.3
NEW="$2" # this build — speaks contract 1.4

# Two clearly-named commands, so the recording shows WHICH build is speaking.
odu-1.3() { "$OLD" "$@"; }
odu-1.4() { "$NEW" "$@"; }

# A moved origin, so the demo never meets the user's own singleton: the origin
# names the namespace (gate, control socket, state home), and two namespaces
# cannot see each other's gate or cell.
export ODU_WEB_ORIGIN="http://127.0.0.1:19499"

# Parse one field out of the service cell (one JSON line; no jq dependency).
cell_field() { sed -n "s/.*\"$1\":\\(\"[^\"]*\"\\|[0-9]*\\).*/\\1/p" | tr -d '"'; }

SERVICE_PID=""
SERVICE_HOME=""
cleanup() {
  # EXPLICIT pid from the service cell — never a pgrep/pkill pattern. The
  # moved origin's state home goes with it, leaving nothing behind.
  [ -n "$SERVICE_PID" ] && kill "$SERVICE_PID" 2>/dev/null
  [ -n "$SERVICE_HOME" ] && rm -rf "$SERVICE_HOME"
}
trap cleanup EXIT

cd "$(mktemp -d /tmp/odu-adopt-skew-XXXX)" || exit 1
# `attach` resolves THIS checkout's run, so the demo dir must be a checkout:
# from a plain directory it exits 1 before ever dialling the service.
git init -q && git -c user.email=a@b.c -c user.name=x commit -qm init --allow-empty

P='\033[1;32m$\033[0m'                                   # green prompt
say() { printf "\033[2;37m# %s\033[0m\n" "$1"; sleep 1.4; }
cmd() { printf "$P %s\n" "$1"; sleep 0.7; }

clear
say "A web daemon from BEFORE #114 comes up on a moved origin. It speaks contract 1.3."
cmd "odu-1.3 web --background -o json"
odu-1.3 web --background -o json; sleep 0.8

cmd "odu-1.3 surface get service"
odu-1.3 surface get service; sleep 1.6
SERVICE_PID="$(odu-1.3 surface get service | cell_field pid)"
SERVICE_HOME="$(odu-1.3 surface get service | cell_field home)"

say "A thin client used to ADOPT this daemon unchecked: the first call came back"
say "as a bare 'undefined' on an exit-1 line (the bug in #115). The fixed client:"
cmd "odu-1.4 attach"
odu-1.4 attach
printf "  [exit %s]\n" "$?"; sleep 1.8

say "Exit 3, with the recovery spelled out. And the recovery itself works:"
cmd "odu-1.4 web --upgrade --background"
odu-1.4 web --upgrade --background; sleep 1.0

cmd "odu-1.4 surface get service"
odu-1.4 surface get service; sleep 2.0
# The 1.4 daemon replaced the drained 1.3 daemon — clean THIS pid up, not the old one.
SERVICE_PID="$(odu-1.4 surface get service | cell_field pid)"

say "Refused honestly, upgraded in place. No 'undefined' anywhere."
sleep 1.6
