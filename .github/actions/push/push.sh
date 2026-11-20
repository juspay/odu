#!/usr/bin/env bash

set -euo pipefail

umask 077

say() { printf '%s\n' "$*"; }
fail() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

trim() {
  printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

cache=$(trim "${ODU_PUSH_CACHE:-}")
cache=${cache%/}
token=$(trim "${ODU_PUSH_TOKEN:-}")
pin=$(trim "${ODU_PUSH_PIN:-}")
requested=$(printf '%s' "${ODU_PUSH_PATHS:-}" | tr -s '[:space:]' '\n' | sed '/^$/d')
event=${GITHUB_EVENT_NAME:-local}

command -v nix >/dev/null 2>&1 ||
  fail "odu push: \`nix\` is not on PATH, and this action never installs it. Install Nix in an earlier step — with the bucket's \"GitHub Actions\" block as its \`nix_conf\` — and run this action after it."
command -v jq >/dev/null 2>&1 ||
  fail "odu push: \`jq\` is not on PATH. GitHub-hosted runners ship it; a self-hosted runner needs it installed."
command -v curl >/dev/null 2>&1 ||
  fail "odu push: \`curl\` is not on PATH. GitHub-hosted runners ship it; a self-hosted runner needs it installed."

# `$GITHUB_SHA` is that commit on every event but one: on `pull_request` it is
# the synthetic MERGE ref (`refs/pull/N/merge`), which nobody fetches by name,
# which moves under the pull request and which disappears when it closes.
# The pull request's own head sha is the commit that built these paths,
# and the event payload is where it is (there is no `$GITHUB_HEAD_SHA`).
commit=${GITHUB_SHA:-}
if [ "$event" = pull_request ] && [ -s "${GITHUB_EVENT_PATH:-}" ]; then
  head=$(jq -r '.pull_request.head.sha // empty' "$GITHUB_EVENT_PATH" 2>/dev/null || true)
  if [ -n "$head" ]; then commit=$head; fi
fi

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/odu-push.XXXXXX")
trap 'rm -rf "$work"' EXIT

# `--impure` is what lets
# `builtins.currentSystem` name the runner.
if [ -z "$requested" ]; then
  say "odu push: no paths named — pushing every flake output for this system"
  # shellcheck disable=SC2016 — the `${…}` below are NIX's interpolations,
  # evaluated by `nix eval`; the shell must hand them over untouched.
  requested=$(
    nix eval --impure --raw --accept-flake-config --expr '
      let
        flake = builtins.getFlake (toString ./.);
        system = builtins.currentSystem;
        named = kind:
          let outputs = flake.${kind}.${system} or { };
          in map (name: ".#${kind}.${system}.\"${name}\"") (builtins.attrNames outputs);
      in
      builtins.concatStringsSep "\n" (builtins.concatMap named [ "packages" "devShells" "checks" ])
    ' < /dev/null
  ) || fail "odu push: could not enumerate this flake's outputs — name \`paths:\` explicitly, or fix the evaluation error above."
  [ -n "$requested" ] ||
    fail "odu push: this flake has no packages, devShells or checks for this system, and \`paths:\` named none either — there is nothing to push."
fi

# `nix path-info` (which the pusher uses to walk the closure) does not build, so an
# installable that was never built would fail with the store's sentence instead
# of this step's.
: > "$work/built"
while IFS= read -r item; do
  case "$item" in
    /*) printf '%s\n' "$item" >> "$work/built" ;;
    *)
      if [ -e "$item" ] || [ -L "$item" ]; then
        # A RELATIVE PATH IS SPELLED `./x`. Nix reads a bare word as a flake
        # reference — `result` fails with "cannot find flake 'flake:result'".
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

pin_args=()
pin_requested=""
pins=no
case "$pin" in
  "")
    default_branch=""
    if [ -s "${GITHUB_EVENT_PATH:-}" ]; then
      default_branch=$(jq -r '.repository.default_branch // empty' "$GITHUB_EVENT_PATH" 2>/dev/null || true)
    fi
    if [ -n "$default_branch" ] && [ "${GITHUB_REF:-}" = "refs/heads/$default_branch" ]; then
      pins=yes
    fi
    ;;
  false | False | FALSE | 0 | no)
    ;;
  true | True | TRUE | 1 | yes)
    pins=yes
    ;;
  *)
    fail "odu push: \`pin:\` is a boolean — \`true\` pins this push's closure, \`false\` never pins, and EMPTY (the default) pins on your repository's default branch (got \"$pin\"). The NAME is derived; a different rule is an expression your workflow writes, e.g. \`pin: \${{ github.ref_name == 'release' }}\`."
    ;;
esac

if [ "$pins" = yes ]; then
  # A pull request's `GITHUB_REF_NAME` is
  # `<n>/merge`, a synthetic ref nobody substitutes.
  ref_name=${GITHUB_HEAD_REF:-}
  [ -n "$ref_name" ] || ref_name=${GITHUB_REF_NAME:-}
  system=$(nix eval --impure --raw --expr 'builtins.currentSystem' < /dev/null) ||
    fail "odu push: could not ask Nix what system this runner is, and a pin's name carries it."
  [ -n "${GITHUB_REPOSITORY:-}" ] ||
    fail "odu push: pinning needs \$GITHUB_REPOSITORY — a pin's name is <owner>/<repo>@<ref>/<system>, and outside Actions there is no repository to name."
  [ -n "$ref_name" ] ||
    fail "odu push: pinning needs \$GITHUB_REF_NAME (or \$GITHUB_HEAD_REF) — a pin's name says which ref it holds."
  pin_requested=$("$here/pin-name.sh" "$GITHUB_REPOSITORY" "$ref_name" "$system")
  pin_args=(--pin "$pin_requested")
fi

if [ -z "$token" ]; then
  if [ "$event" = "push" ]; then
    fail "odu push: no token — \`token:\` is empty and this is a \`push\` event, which must publish its closure. Set the input from a repository secret: odu's own workflow reads \`secrets.ODU_CACHE_TOKEN\`, and a bucket page mints a write token once."
  fi
  say "odu push: no token, so nothing was pushed. Built $count store paths; a \`$event\` event is not required to publish."
  summary "### Cache push — \`${cache:-./flake.nix}\`

**Built, pushed nothing.** No token: a \`$event\` event is not required to publish, so this step built $count store path(s) and stopped."
  if [ -n "$pin_requested" ]; then
    summary "**Pin:** \`$pin_requested\` was not re-pointed — nothing was pushed."
  fi
  exit 0
fi

repo_root=$(cd "$here/../../.." && pwd)
[ -f "$repo_root/flake.nix" ] ||
  fail "odu push: no flake.nix at $repo_root — this action expects to live at .github/actions/push in the odu checkout it pushes with."

say "odu push: building the pusher from $repo_root"
pusher_out=$(nix build -L --no-link --print-out-paths --accept-flake-config \
  -- "$repo_root#odu")
odu="$pusher_out/bin/odu"
[ -x "$odu" ] || fail "odu push: the pusher build at $repo_root produced no executable at $odu."

if [ -z "$cache" ]; then
  say "odu push: no \`cache:\` input — asking ./flake.nix through \`odu cache target\`"
  cache=$("$odu" cache target) ||
    fail "odu push: \`cache:\` was omitted and \`odu cache target\` could not name one odu cache in ./flake.nix — its sentence is above. Name the bucket's substituter URL in \`cache:\`, or fix the \`extra-substituters\` line."
  cache=${cache%/}
  [ -n "$cache" ] ||
    fail "odu push: \`odu cache target\` succeeded and printed nothing, which it cannot do — the pusher at $odu is not the odu this action expects."
  say "odu push: ./flake.nix names $cache"
fi

result="$work/push.json"
set +e
# `${pin_args[@]+…}` and not `"${pin_args[@]}"`: a macOS runner's bash is 3.2,
# where an empty array expanded under `set -u` is an unbound variable.
ODU_CACHE_TOKEN="$token" "$odu" cache push --cache "$cache" --output json \
  ${pin_args[@]+"${pin_args[@]}"} \
  --commit "$commit" \
  "${targets[@]}" > "$result"
status=$?
set -e

if ! jq -e . "$result" >/dev/null 2>&1; then
  fail "odu cache push exited $status without a result — see its message above."
fi

pushed=$(jq -r '.pushed' "$result")
already=$(jq -r '.alreadyPresent' "$result")
upstream=$(jq -r '.skippedUpstream' "$result")
failed=$(jq -r '.failed' "$result")
page=$(jq -r '.pageUrl' "$result")
substituter=$(jq -r '.substituter' "$result")

pinned_name=$(jq -r '.pinned.name // empty' "$result")
pinned_paths=$(jq -r '.pinned.rootPaths // empty' "$result")

summary "### Cache push — \`$cache\`

| pushed | already present | skipped (upstream) | failed |
| ---: | ---: | ---: | ---: |
| $pushed | $already | $upstream | $failed |

[Bucket page]($page)"

if [ "$failed" != "0" ]; then
  jq -r '.failures[] | "::error::\(.path) — \(.message)"' "$result"
fi

if [ "$status" -ne 0 ] || [ "$failed" != "0" ]; then
  fail "odu push: \`odu cache push\` exited $status with $failed refused path(s) — the push did not land."
fi

if [ -n "$pinned_name" ]; then
  say "odu push: the pin \"$pinned_name\" now holds $pinned_paths path(s)"
  summary "**Pinned:** \`$pinned_name\` now holds $pinned_paths path(s) — this closure stays out of garbage collection until a later push of this ref, on this system, moves the pin."
elif [ -n "$pin_requested" ]; then
  fail "odu push: \`--pin $pin_requested\` was asked for and \`odu cache push\` answered no pin — the closure is pushed but nothing holds it."
fi

auth_config="$work/curl.conf"
printf 'header = "authorization: Bearer %s"\n' "$token" > "$auth_config"
export ODU_PUSH_CURL_CONFIG="$auth_config"

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

checked="$work/checked"
xargs -n 2 -P 8 "$here/check.sh" < "$checks" > "$checked" || true

answered=$(wc -l < "$checked" | tr -d ' ')
if [ "$answered" != "$expected" ]; then
  fail "odu push: the proof asked $expected paths and got $answered answers — the substituter or curl stopped mid-check."
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
