#!/usr/bin/env bash
#
# ONE PATH'S PROOF, for `.github/actions/push`'s verification.
#
#   check.sh <store path> <substituter>
#
# Asks what a Nix client asks. The narinfo must answer at the SUBSTITUTER's
# address — `<substituter>/<hash>.narinfo`, where `<hash>` is the store path's
# own 32-character hash — and its `URL:` and `FileSize:` lines
# must be there, and the NAR they name must answer 200 with a `Content-Length`
# equal to `FileSize:` — the truncated object a proxy's body cap produces is a
# narinfo that answers perfectly and a NAR that does not.
#
# A NARINFO ALONE IS NOT A PROOF. That is the whole reason this asks twice.
#
# Prints `OK <store path>` or `FAIL <store path> — <what is wrong>`, one line,
# and exits 0 or 1. The caller runs these in parallel and counts the lines, so a
# check that dies without an answer is distinguishable from one that passed.
#
# The bearer token, when the bucket needs one, arrives as a curl config file in
# `$ODU_PUSH_CURL_CONFIG` — never as an argument, where `ps` would read it.

set -u

store_path=${1:-}
substituter=${2:-}
config=${ODU_PUSH_CURL_CONFIG:-}

[ -n "$store_path" ] && [ -n "$substituter" ] || {
  printf 'FAIL %s — check.sh was called without a store path and a substituter\n' "$store_path"
  exit 1
}

# THE NARINFO'S NAME IS THE STORE PATH'S HASH: the 32 characters of the
# basename before the first dash. Derived HERE rather than handed in, so the one
# place that asks for a narinfo is the one place that spells its name.
base=${store_path##*/}
narinfo_url="$substituter/${base:0:32}.narinfo"

no() {
  printf 'FAIL %s — %s\n' "$store_path" "$*"
  exit 1
}

field() {
  printf '%s\n' "$1" | tr -d '\r' | sed -n "s/^$2:[[:space:]]*//p" | tail -1
}

narinfo=$(curl -sS -f -K "$config" "$narinfo_url") ||
  no "its narinfo did not answer at $narinfo_url"

url=$(field "$narinfo" URL)
size=$(field "$narinfo" FileSize)
[ -n "$url" ] || no "its narinfo at $narinfo_url has no URL: line"
[ -n "$size" ] || no "its narinfo at $narinfo_url has no FileSize: line"

nar_url="$substituter/$url"
answer=$(curl -sS -I -L -K "$config" -w 'HTTP_CODE:%{http_code}\n' "$nar_url" 2>/dev/null) || true
code=${answer##*HTTP_CODE:}
code=${code%%[!0-9]*}
length=$(printf '%s\n' "$answer" | tr -d '\r' |
  sed -n 's/^[Cc]ontent-[Ll]ength:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | tail -1)

[ "$code" = "200" ] || no "its NAR answers $code at $nar_url"
[ -n "$length" ] || no "its NAR's answer carries no Content-Length at $nar_url"
[ "$length" = "$size" ] ||
  no "its NAR is $length bytes but its narinfo says $size at $nar_url"

printf 'OK %s\n' "$store_path"
