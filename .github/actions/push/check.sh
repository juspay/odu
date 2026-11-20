#!/usr/bin/env bash

set -u

store_path=${1:-}
substituter=${2:-}
config=${ODU_PUSH_CURL_CONFIG:-}

[ -n "$store_path" ] && [ -n "$substituter" ] || {
  printf 'FAIL %s — check.sh was called without a store path and a substituter\n' "$store_path"
  exit 1
}

# THE NARINFO'S NAME IS THE STORE PATH'S HASH: the 32 characters of the
# basename before the first dash.
base=${store_path##*/}
narinfo_url="$substituter/${base:0:32}.narinfo"

no() {
  printf 'FAIL %s — %s\n' "$store_path" "$*"
  exit 1
}

field() {
  printf '%s\n' "$1" | tr -d '\r' | sed -n "s/^$2:[[:space:]]*//p" | tail -1
}

# `--retry-all-errors` is what makes
# `--retry` cover a connection reset as well as a 5xx — without it curl retries
# only "transient" HTTP statuses and gives up on exactly the failure seen.
# curl's default connect timeout is 300 seconds.
retry=(--retry 5 --retry-all-errors --retry-delay 2 --retry-max-time 30 --connect-timeout 10)

narinfo=$(curl -sS -f "${retry[@]}" -K "$config" "$narinfo_url") ||
  no "its narinfo did not answer at $narinfo_url"

url=$(field "$narinfo" URL)
size=$(field "$narinfo" FileSize)
[ -n "$url" ] || no "its narinfo at $narinfo_url has no URL: line"
[ -n "$size" ] || no "its narinfo at $narinfo_url has no FileSize: line"

nar_url="$substituter/$url"
answer=$(curl -sS -I -L "${retry[@]}" -K "$config" -w 'HTTP_CODE:%{http_code}\n' "$nar_url" 2>/dev/null) || true
code=${answer##*HTTP_CODE:}
code=${code%%[!0-9]*}
length=$(printf '%s\n' "$answer" | tr -d '\r' |
  sed -n 's/^[Cc]ontent-[Ll]ength:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | tail -1)

[ "$code" = "200" ] || no "its NAR answers $code at $nar_url"
[ -n "$length" ] || no "its NAR's answer carries no Content-Length at $nar_url"
[ "$length" = "$size" ] ||
  no "its NAR is $length bytes but its narinfo says $size at $nar_url"

printf 'OK %s\n' "$store_path"
