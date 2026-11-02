#!/usr/bin/env bash
#
# THE PUSHER BEHIND `.github/actions/push`.
#
# One step in any workflow, for any repository, to any odu bucket:
#
#   - uses: juspay/odu/.github/actions/push@<sha>
#     with:
#       origin: https://cache.kolu.dev
#       bucket: kolu
#       token: ${{ secrets.ODU_CACHE_TOKEN }}
#       paths: |
#         .#my-package
#
# ## The pusher is this checkout's odu
#
# `odu` is built from `$repo_root#odu`, where the repo root is derived from this
# script's own path — `action_path/../../..`. A repository that pins the action
# to a commit therefore pushes with that commit's odu, and odu's own workflow
# (`uses: ./.github/actions/push`) pushes with the odu it just built. There is
# no release to download and no version to drift.
#
# THAT BUILD IS ODU'S OWN FLAKE AND NOTHING ELSE — `--accept-flake-config`, so
# odu's `nixConfig` (which names odu's cache) applies on a Nix that trusts it,
# and a Nix that does not trust it builds odu instead. This script adds no
# substituter of its own: the fact of where odu is substitutable from lives in
# odu's flake, and a copy here would be a second place to keep it right.
#
# ## The caller's paths build with the caller's Nix
#
# The installables named in `paths` are built with `--accept-flake-config` and
# NOTHING ELSE: their own flake's `nixConfig`, their own `nix.conf`, whatever
# the runner is configured with. An action that added a substituter or a trusted
# key to a user's build would be choosing a cache for a build it does not own.
#
# ## Nix must already be on PATH
#
# This never installs Nix. Installing one would decide, on a repository's
# behalf, which Nix it builds with; the bucket page's "GitHub Actions" block is
# the `nix_conf` for whichever install step the repository already runs.
#
# ## The token rule
#
#   - no token on a pull request  → build (the PR is owed that), push nothing,
#                                   say so, succeed
#   - no token on a `push` event  → fail, naming the missing secret: a push is
#                                   where this job must publish, and going green
#                                   having warmed nothing is the state a cache
#                                   job exists to make impossible
#   - the token is never echoed, and never appears in a command line: it is
#     read from the environment, handed to `odu` through the environment, and
#     handed to curl through a 0600 config file that is removed on exit
#
# ## It proves what it pushed, where Nix will ask
#
# `odu cache push` answers which paths the bucket SERVES (what it already had,
# plus what this push stored, minus the upstream-signed paths it refuses by
# design and minus any it refused) and the SUBSTITUTER URL the bucket publishes
# — its own domain when it has one. For every served path, `check.sh` asks
# `<substituter>/<hash>.narinfo`, exactly as a Nix client would, reads the
# narinfo's `URL:` and `FileSize:`, and requires the NAR to answer 200 with
# a matching `Content-Length`. All of it over plain HTTP: no local narinfo
# cache can answer for the bucket, and a truncated object — the failure a
# proxy's body cap causes — is caught rather than counted as landed.
#
# ## The readout
#
# `$GITHUB_STEP_SUMMARY` gets a table read from `odu cache push --output json`
# — the command's own result, never its human text.

set -euo pipefail

# The curl config holds the bearer token: nobody else's business, and not long
# for this world.
umask 077

say() { printf '%s\n' "$*"; }
fail() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

trim() {
  printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

# ── inputs ──────────────────────────────────────────────────────────────────

origin=$(trim "${ODU_PUSH_ORIGIN:-}")
origin=${origin%/}
bucket=$(trim "${ODU_PUSH_BUCKET:-}")
token=$(trim "${ODU_PUSH_TOKEN:-}")
requested=$(printf '%s' "${ODU_PUSH_PATHS:-}" | tr -s '[:space:]' '\n' | sed '/^$/d')
event=${GITHUB_EVENT_NAME:-local}

[ -n "$origin" ] || fail "odu push: the \`origin:\` input is empty — give the bucket's URL, e.g. https://cache.kolu.dev."
[ -n "$bucket" ] || fail "odu push: the \`bucket:\` input is empty — give the bucket's name, e.g. kolu."
[ -n "$requested" ] ||
  fail "odu push: the \`paths:\` input names nothing — give store paths, \`result\` links, or flake installables (one per line)."

command -v nix >/dev/null 2>&1 ||
  fail "odu push: \`nix\` is not on PATH, and this action never installs it. Install Nix in an earlier step — with the bucket's \"GitHub Actions\" block as its \`nix_conf\` — and run this action after it."
command -v jq >/dev/null 2>&1 ||
  fail "odu push: \`jq\` is not on PATH. GitHub-hosted runners ship it; a self-hosted runner needs it installed."
command -v curl >/dev/null 2>&1 ||
  fail "odu push: \`curl\` is not on PATH. GitHub-hosted runners ship it; a self-hosted runner needs it installed."

# ── what the caller named ───────────────────────────────────────────────────

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/odu-push.XXXXXX")
trap 'rm -rf "$work"' EXIT

# AN INSTALLABLE IS BUILT FIRST and an existing path is used as it is: `nix
# path-info` (which the pusher uses to walk the closure) does not build, so an
# installable that was never built would fail with the store's sentence instead
# of this step's. The build carries the CALLER'S configuration and no
# substituter of ours.
: > "$work/built"
while IFS= read -r item; do
  case "$item" in
    /*) printf '%s\n' "$item" >> "$work/built" ;;
    *)
      if [ -e "$item" ] || [ -L "$item" ]; then
        # A RELATIVE PATH IS SPELLED `./x`. Nix reads a bare word as a flake
        # reference — `result` fails with "cannot find flake 'flake:result'" —
        # and a `result` link is exactly the thing this input promises to take.
        case "$item" in
          ./* | ../*) printf '%s\n' "$item" >> "$work/built" ;;
          *) printf './%s\n' "$item" >> "$work/built" ;;
        esac
      else
        say "odu push: building $item"
        nix build -L --no-link --print-out-paths --accept-flake-config \
          -- "$item" < /dev/null >> "$work/built"
      fi
      ;;
  esac
done <<< "$requested"

targets=()
while IFS= read -r line; do
  if [ -n "$line" ]; then targets+=("$line"); fi
done < "$work/built"

# A POSITIVE ASSERTION. A build that produced nothing would otherwise push
# nothing and still report success.
[ "${#targets[@]}" -gt 0 ] ||
  fail "odu push: the paths named produced no store paths — there is nothing to push, and a cache step that reports success having published nothing is the bug it exists to prevent."
count=${#targets[@]}

summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
  else
    printf '%s\n' "$1"
  fi
}

# ── the token, before anything expensive ────────────────────────────────────

if [ -z "$token" ]; then
  if [ "$event" = "push" ]; then
    fail "odu push: no token — \`token:\` is empty and this is a \`push\` event, which must publish its closure. Set the input from a repository secret: odu's own workflow reads \`secrets.ODU_CACHE_TOKEN\`, and a bucket page mints a write token once."
  fi
  say "odu push: no token, so nothing was pushed. Built $count store paths; a \`$event\` event is not required to publish."
  summary "### Cache push — \`$bucket\` on \`$origin\`

**Built, pushed nothing.** No token: a \`$event\` event is not required to publish, so this step built $count store path(s) and stopped."
  exit 0
fi

# ── the pusher, from this action's own checkout ─────────────────────────────

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$here/../../.." && pwd)
[ -f "$repo_root/flake.nix" ] ||
  fail "odu push: no flake.nix at $repo_root — this action expects to live at .github/actions/push in the odu checkout it pushes with."

say "odu push: building the pusher from $repo_root"
# ODU'S OWN FLAKE DECIDES WHERE ODU IS SUBSTITUTABLE FROM (`nixConfig`), and
# `--accept-flake-config` is the whole of this script's contribution to that
# decision. Spelling the substituter here would be a second copy of a fact the
# flake already states, and a copy that could drift from it.
pusher_out=$(nix build -L --no-link --print-out-paths --accept-flake-config \
  -- "$repo_root#odu")
odu="$pusher_out/bin/odu"
[ -x "$odu" ] || fail "odu push: the pusher build at $repo_root produced no executable at $odu."

# ── the push ────────────────────────────────────────────────────────────────

result="$work/push.json"
set +e
# The token rides in the environment, which is how `odu cache push` resolves it
# by design ($ODU_CACHE_TOKEN, second in its order) — not in argv, where `ps`
# would read it.
ODU_CACHE_TOKEN="$token" "$odu" cache push "$bucket" --origin "$origin" --output json \
  "${targets[@]}" > "$result"
status=$?
set -e

# A PUSH THAT DIED BEFORE ANSWERING has no JSON: its own message is already in
# the log, and there is nothing here to summarize.
if ! jq -e . "$result" >/dev/null 2>&1; then
  fail "odu cache push exited $status without a result — see its message above."
fi

pushed=$(jq -r '.pushed' "$result")
already=$(jq -r '.alreadyPresent' "$result")
upstream=$(jq -r '.skippedUpstream' "$result")
failed=$(jq -r '.failed' "$result")
page=$(jq -r '.pageUrl' "$result")
substituter=$(jq -r '.substituter' "$result")

summary "### Cache push — \`$bucket\` on \`$origin\`

| pushed | already present | skipped (upstream) | failed |
| ---: | ---: | ---: | ---: |
| $pushed | $already | $upstream | $failed |

[Bucket page]($page)"

if [ "$failed" != "0" ]; then
  jq -r '.failures[] | "::error::\(.path) — \(.message)"' "$result"
fi

# THE EXIT STATUS IS THE PUSH'S OWN VERDICT, and a JSON that parses is not a
# permission to ignore it: a command that failed has not pushed, whatever the
# counts say.
if [ "$status" -ne 0 ] || [ "$failed" != "0" ]; then
  fail "odu push: \`odu cache push\` exited $status with $failed refused path(s) — the push did not land."
fi

# ── proof: every path the bucket serves answers where Nix will ask ─────────

# The auth header lives in a config file, read by curl with `-K`, so the token
# is never an argument. A public bucket ignores it; a private one needs it.
auth_config="$work/curl.conf"
printf 'header = "authorization: Bearer %s"\n' "$token" > "$auth_config"
export ODU_PUSH_CURL_CONFIG="$auth_config"

# `<store path> <substituter>` per served path — `check.sh` derives the narinfo's
# URL from those, in the one place that asks for it.
checks="$work/checks"
: > "$checks"
while IFS= read -r store_path; do
  printf '%s %s\n' "$store_path" "$substituter" >> "$checks"
done < <(jq -r '.served[]' "$result")

expected=$(wc -l < "$checks" | tr -d ' ')
if [ "$expected" = "0" ]; then
  summary "Nothing to verify: the bucket serves no path from this closure yet (every member was upstream-signed or already refused)."
  exit 0
fi

# PARALLEL, one process per path, and every path ANSWERED: `check.sh` prints
# `OK` or `FAIL` for each, so a check that died silently cannot pass for one
# that passed.
checked="$work/checked"
xargs -n 2 -P 8 "$here/check.sh" < "$checks" > "$checked" || true

answered=$(wc -l < "$checked" | tr -d ' ')
if [ "$answered" != "$expected" ]; then
  fail "odu push: the proof asked $expected paths and got $answered answers — the origin or curl stopped mid-check."
fi

refused=$(grep '^FAIL ' "$checked" || true)
if [ -n "$refused" ]; then
  missing_count=$(printf '%s\n' "$refused" | wc -l | tr -d ' ')
  printf '%s\n' "$refused" | sed 's/^FAIL /::error::/'
  summary "**$missing_count of $expected served paths do not answer** at \`$substituter\` — this push did not land."
  exit 1
fi

say "odu push: every one of the $expected served paths is served at $substituter"
summary "**Verified:** every one of the $expected served paths answers its narinfo at \`$substituter\` and its NAR at the size the narinfo claims — plain HTTP, so no local narinfo cache can answer for the bucket."
