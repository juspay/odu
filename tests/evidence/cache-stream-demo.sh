#!/usr/bin/env bash
# Reproducible terminal evidence for juspay/odu#132 — the cache STREAMS.
#
# One 2 GiB generated path is pushed to a bucket and then read back by four
# concurrent clients, while the service's RSS is sampled once a second. The
# claim on screen: the daemon's memory does not follow the size of the NAR. A
# cache that buffered an upload or a read would show RSS climbing toward the
# NAR's size; this one sits at its own baseline the whole way.
#
# Recorded with asciinema, rendered to a gif with agg — see
# dev/skills/pr-evidence/SKILL.md:
#
#   odu=$(nix build .#odu --no-link --print-out-paths)/bin/odu
#   asciinema rec --headless --window-size 92x24 -i 2 --overwrite \
#     -c "bash tests/evidence/cache-stream-demo.sh $odu $PWD" /tmp/cache-stream.cast
#
# Nothing here touches your store or your own `odu web`: the daemon's cache and
# the builder are chroots under one temp dir, exactly as the e2e suite sets them
# up. SIZE=2G is the brief's number; SIZE=256M runs the same story in a tenth of
# the time when you are editing the script rather than recording it.
set -u
ODU="$1"          # the odu under test (nix-built: the wrapper bakes ODU_SELF)
WT="$2"           # the odu checkout
SIZE="${SIZE:-2G}"
PORT="${PORT:-18991}"

ROOT=$(mktemp -d /tmp/odu-cache-stream-XXXX)
BUILDER="local?root=$ROOT/builder"
SERVER="local?root=$ROOT/server"
printf '{"%s":"localhost"}' "$(nix eval --impure --raw --expr builtins.currentSystem)" \
  > "$ROOT/hosts.json"

export ODU_STATE_DIR="$ROOT/state" ODU_HOSTS="$ROOT/hosts.json"
export ODU_WEB_ORIGIN="http://127.0.0.1:$PORT"
export ODU_ROOT_TOKEN="demo-root-token"
export ODU_CACHE_STORE="$SERVER"

# The builder is a chroot, so `head` has to come from the chroot's own store:
# the host's coreutils is handed to the derivation as an INPUT (`builtins.storePath`),
# which is how a path reaches a chroot store unchanged.
COREUTILS=$(dirname "$(dirname "$(readlink -f "$(type -P head)")")")

daemon_pid() { "$ODU" surface get service 2>/dev/null | grep -o '"pid": *[0-9]*' | grep -o '[0-9]*$'; }
cleanup() {
  rm -f "$ROOT/watching"
  pid=$(daemon_pid) && [ -n "$pid" ] && kill "$pid" 2>/dev/null
  # A chroot store's paths are read-only by construction (0444/0555), and a
  # plain `rm -rf` cannot unlink inside a 0555 directory.
  chmod -R u+w "$ROOT" 2>/dev/null
  rm -rf "$ROOT"
}
trap cleanup EXIT

P='\033[1;32m$\033[0m'
say() { printf "\033[2;37m# %s\033[0m\n" "$1"; sleep 1.2; }
cmd() { printf "$P %s\n" "$1"; sleep 0.5; }
# RSS in MiB — the unit `ps` does not use.
rss_mib() { awk -v k="$1" 'BEGIN { printf "%d", k / 1024 }'; }
now_rss() { rss_mib "$(ps -o rss= -p "$PID" 2>/dev/null || echo 0)"; }

# A live line the recorder can show while something long runs. Driven by a flag
# FILE rather than by `kill`, so the loop stops at a sleep boundary and nothing
# is left sampling a daemon that has gone.
watch_rss() {
  : > "$ROOT/watching"
  ( while [ -e "$ROOT/watching" ]; do
      printf '\r  daemon RSS %s MiB   ' "$(now_rss)"
      sleep 1
    done ) &
  WATCH=$!
}
unwatch() {
  rm -f "$ROOT/watching"
  wait "$WATCH" 2>/dev/null
  printf '\r  daemon RSS %s MiB   \n' "$(now_rss)"
}

# ── a 2 GiB path, built into a store the cache has never seen ────────────────
say "A private world: the cache and the builder are chroot stores, so nothing touches the host store."
cmd "nix build --store $BUILDER … 'head -c $SIZE /dev/urandom > \$out'"
# The chroot's own `/nix/store` is where the output lands, so the host sees it
# at `$ROOT/builder$BIG` — while `$BIG` is the path a client and the cache use.
BIG=$(nix build --store "$BUILDER" --no-link --print-out-paths --impure --expr \
  "derivation { name = \"stream-$SIZE\"; system = builtins.currentSystem;
     coreutils = builtins.storePath $COREUTILS; builder = \"/bin/sh\";
     args = [ \"-c\" \"\$coreutils/bin/head -c $SIZE /dev/urandom > \$out\" ]; }" \
  2> >(grep -v '^copying path' >&2))
echo "  $BIG"; sleep 1
cmd "du -h --apparent-size \$BUILDER$BIG"
du -h --apparent-size "$ROOT/builder$BIG"; sleep 1

# ── the service, with its cache ──────────────────────────────────────────────
say "odu web: one service, and the cache it serves. Administration needs \$ODU_ROOT_TOKEN."
cmd "odu web --background"
"$ODU" web --background 2>&1 | grep -E "started|http"; sleep 2
PID=$(daemon_pid)
echo "  daemon pid $PID"; sleep 0.8
BASELINE=$(now_rss)
echo "  daemon RSS before anything: $BASELINE MiB"; sleep 1

cmd "odu cache create main --retention-days 0"
"$ODU" cache create main --retention-days 0 2>&1 | head -4; sleep 1
BUCKET="http://127.0.0.1:$PORT/main"
TOKEN=$("$ODU" cache token mint main --write -o json | grep -o '"token": *"[^"]*"' | cut -d'"' -f4)

# One sample a second, into the file of the phase being run, so each phase has
# its own peak and the push cannot hide behind the reads.
SAMPLES="$ROOT/rss"
phase() { : > "$ROOT/rss"; PHASE="$1"; }
( while kill -0 "$PID" 2>/dev/null; do
    ps -o rss= -p "$PID" 2>/dev/null >> "$SAMPLES"; sleep 1
  done ) &
SAMPLER=$!
peak() { rss_mib "$(sort -n "$SAMPLES" | tail -1)"; }

# ── push ─────────────────────────────────────────────────────────────────────
say "PUSH: the NAR is streamed through the daemon, never held. Watch RSS, not the clock."
phase push
cmd "odu cache push main $BIG"
watch_rss
NIX_REMOTE="$BUILDER" ODU_CACHE_TOKEN="$TOKEN" \
  "$ODU" cache push main "$BIG" 2>&1 | grep -vE "^$" | tail -4
unwatch
PUSH_PEAK=$(peak); sleep 1

HASH=$(basename "$BIG" | cut -c1-32)
cmd "curl -s $BUCKET/$HASH.narinfo"
NARINFO=$(curl -s "$BUCKET/$HASH.narinfo")
echo "$NARINFO" | grep -E "^(StorePath|NarHash|NarSize|Compression|URL|Sig):"; sleep 1.2
NARSIZE=$(echo "$NARINFO" | awk '/^NarSize:/ { print $2 }')
NARURL="$BUCKET/$(echo "$NARINFO" | awk '/^URL:/ { print $2 }')"

# ── four concurrent reads ────────────────────────────────────────────────────
say "READ: four clients fetch that NAR at the same time."
cmd "for i in 1 2 3 4; do curl -s -o /dev/null -w '%{size_download}\\n' $NARURL & done; wait"
phase read
START=$(date +%s)
PIDS=()
for _ in 1 2 3 4; do
  curl -s -o /dev/null -w '%{size_download}\n' "$NARURL" &
  PIDS+=($!)
done
for pid in "${PIDS[@]}"; do wait "$pid"; done
END=$(date +%s)
READ_PEAK=$(peak)
printf '  4 × %s bytes in %ss, daemon RSS %s MiB\n' "$NARSIZE" "$((END - START))" "$(now_rss)"
sleep 1.2

# ── the claim ────────────────────────────────────────────────────────────────
kill "$SAMPLER" 2>/dev/null; wait "$SAMPLER" 2>/dev/null
MAX=$((PUSH_PEAK > READ_PEAK ? PUSH_PEAK : READ_PEAK))
MIB=$((NARSIZE / 1024 / 1024))
clear
say "THE CLAIM: the service's memory does not follow the NAR."
printf '  NAR size         %s MiB   (4 concurrent readers move %s MiB)\n' "$MIB" "$((MIB * 4))"
printf '  daemon RSS       %s MiB idle baseline\n' "$BASELINE"
printf '                   %s MiB peak while pushing\n' "$PUSH_PEAK"
printf '                   %s MiB peak with four reads in flight\n' "$READ_PEAK"
printf '  growth           %+d MiB, over a path %s times that size\n' \
  "$((MAX - BASELINE))" "$((MIB / (MAX > BASELINE ? MAX - BASELINE : 1)))"
if [ "$MAX" -lt "$MIB" ]; then
  printf '  \033[1;32mFLAT\033[0m — %s MiB peak against a %s MiB path\n' "$MAX" "$MIB"
else
  printf '  \033[1;31mNOT FLAT\033[0m — %s MiB peak against a %s MiB path\n' "$MAX" "$MIB"
fi
sleep 3
