#!/usr/bin/env bash
#
# THE PUSHER BEHIND `.github/actions/push`.
#
# One step in any workflow, for any repository, to any odu bucket:
#
#   - uses: juspay/odu/.github/actions/push@<sha>
#     with:
#       cache: https://cache.kolu.dev/kolu-r2
#       token: ${{ secrets.ODU_CACHE_TOKEN }}
#       pin: ${{ github.ref_name == github.event.repository.default_branch }}
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
# ## The pin
#
# `pin:` is a BOOLEAN and this script decides nothing about when a pin may
# move: the workflow does, with `${{ github.ref_name ==
# github.event.repository.default_branch }}` or whatever rule it holds. A
# policy baked in here is a policy the one repository whose branch is called
# something else cannot see.
#
# THE NAME IS DERIVED (`pin-name.sh`): `<owner>/<repo>@<ref>/<system>`. Four
# repositories share one bucket and each matrix job pushes a different
# system's closure, so a typed name is a name two jobs collide on — and the
# collision is silent, because re-pointing a pin releases what it held.
#
# IT IS THE PUSH THAT PINS — `odu cache push --pin <name>`: one command, the
# push's own write token, and a pin only when every path landed (a pin over a
# half-pushed closure would promise paths the bucket does not have). A write
# token is authority enough because a write token can already keep a closure
# alive by pushing it again every night; a pin is that same promise made once.
# It re-points only a pin a WRITE token made: re-pointing releases what the
# pin held before, so an administrator's pin answers 403 instead of being
# dropped by a workflow. Deleting a pin stays an administrator's.
#
# ## What gets pushed
#
# `paths:` as given, or — when it is omitted — EVERY flake output for the
# runner's system: `packages.<system>`, `devShells.<system>` and
# `checks.<system>`, enumerated by Nix. That is the set a developer's machine
# substitutes, and it is what makes a pin worth taking: a pin over three named
# packages holds three packages.
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

# WHERE THIS ACTION LIVES. The pusher is built from the checkout above it
# (`repo_root` below) and the two helpers beside it are addressed from here.
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# THE ONE FACT THIS ACTION IS GIVEN: the substituter URL. Where a push is
# TAKEN and which bucket it lands in are the cache's to state — `odu cache
# push --cache` reads them off its `nix-cache-info` — because reads come from
# the store now and a read address is no longer a push address.
cache=$(trim "${ODU_PUSH_CACHE:-}")
cache=${cache%/}
token=$(trim "${ODU_PUSH_TOKEN:-}")
pin=$(trim "${ODU_PUSH_PIN:-}")
requested=$(printf '%s' "${ODU_PUSH_PATHS:-}" | tr -s '[:space:]' '\n' | sed '/^$/d')
event=${GITHUB_EVENT_NAME:-local}

[ -n "$cache" ] || fail "odu push: the \`cache:\` input is empty — give the substituter URL your nix.conf uses, e.g. https://cache.kolu.dev/kolu-r2."

command -v nix >/dev/null 2>&1 ||
  fail "odu push: \`nix\` is not on PATH, and this action never installs it. Install Nix in an earlier step — with the bucket's \"GitHub Actions\" block as its \`nix_conf\` — and run this action after it."
command -v jq >/dev/null 2>&1 ||
  fail "odu push: \`jq\` is not on PATH. GitHub-hosted runners ship it; a self-hosted runner needs it installed."
command -v curl >/dev/null 2>&1 ||
  fail "odu push: \`curl\` is not on PATH. GitHub-hosted runners ship it; a self-hosted runner needs it installed."

# ── what to push ────────────────────────────────────────────────────────────

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/odu-push.XXXXXX")
trap 'rm -rf "$work"' EXIT

# NO `paths:` MEANS THE WHOLE FLAKE, for the system this runner is: every
# `packages.<system>`, `devShells.<system>` and `checks.<system>` output.
#
# That is the set a developer's machine actually substitutes — the dev shell
# is most of what a fresh checkout waits for, and the checks are what CI is
# about to build anyway — and it is what makes `pin: true` worth having: a
# pin over three named packages holds three packages, while a pin over this
# holds the tree.
#
# ENUMERATED BY NIX, not by a list somebody keeps current: a flake that gains
# an output gains it here on the next push. `--impure` is what lets
# `builtins.currentSystem` name the runner instead of this script guessing,
# and `getFlake` of the checkout evaluates the same flake the build will.
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

# ── the pin ─────────────────────────────────────────────────────────────────

# `pin:` IS A BOOLEAN, and the action holds no policy of its own about when a
# pin may move. The workflow decides — `${{ github.ref_name ==
# github.event.repository.default_branch }}` is the line odu's own uses — and
# a step that carries a policy its caller cannot see is a step that surprises
# the one repository whose branch is called something else.
#
# THE NAME IS DERIVED (`pin-name.sh`), never typed: four repositories share
# one bucket and each matrix job pushes a different system's closure, so a
# name a person writes is a name two jobs eventually collide on.
pin_args=()
pin_requested=""
case "$pin" in
  "" | false | False | FALSE | 0 | no)
    ;;
  true | True | TRUE | 1 | yes)
    # THE REF THAT WAS PUSHED. A pull request's `GITHUB_REF_NAME` is
    # `<n>/merge`, a synthetic ref nobody substitutes, so the head branch is
    # what a pin over that build should be called.
    ref_name=${GITHUB_HEAD_REF:-}
    [ -n "$ref_name" ] || ref_name=${GITHUB_REF_NAME:-}
    system=$(nix eval --impure --raw --expr 'builtins.currentSystem' < /dev/null) ||
      fail "odu push: could not ask Nix what system this runner is, and a pin's name carries it."
    [ -n "${GITHUB_REPOSITORY:-}" ] ||
      fail "odu push: \`pin: true\` needs \$GITHUB_REPOSITORY — a pin's name is <owner>/<repo>@<ref>/<system>, and outside Actions there is no repository to name."
    [ -n "$ref_name" ] ||
      fail "odu push: \`pin: true\` needs \$GITHUB_REF_NAME (or \$GITHUB_HEAD_REF) — a pin's name says which ref it holds."
    pin_requested=$("$here/pin-name.sh" "$GITHUB_REPOSITORY" "$ref_name" "$system")
    pin_args=(--pin "$pin_requested")
    ;;
  *)
    fail "odu push: \`pin:\` is a boolean — \`true\` pins this push's closure, anything falsy pins nothing (got \"$pin\"). The NAME is derived; to pin only on your default branch, write \`pin: \${{ github.ref_name == github.event.repository.default_branch }}\`."
    ;;
esac

# ── the token, before anything expensive ────────────────────────────────────

if [ -z "$token" ]; then
  if [ "$event" = "push" ]; then
    fail "odu push: no token — \`token:\` is empty and this is a \`push\` event, which must publish its closure. Set the input from a repository secret: odu's own workflow reads \`secrets.ODU_CACHE_TOKEN\`, and a bucket page mints a write token once."
  fi
  say "odu push: no token, so nothing was pushed. Built $count store paths; a \`$event\` event is not required to publish."
  summary "### Cache push — \`$cache\`

**Built, pushed nothing.** No token: a \`$event\` event is not required to publish, so this step built $count store path(s) and stopped."
  if [ -n "$pin_requested" ]; then
    summary "**Pin:** \`$pin_requested\` was not re-pointed — nothing was pushed."
  fi
  exit 0
fi

# ── the pusher, from this action's own checkout ─────────────────────────────

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
# `${pin_args[@]+…}` and not `"${pin_args[@]}"`: a macOS runner's bash is 3.2,
# where an empty array expanded under `set -u` is an unbound variable. The pin
# NAME is argv's business — it is not a secret; the token is still never there.
ODU_CACHE_TOKEN="$token" "$odu" cache push --cache "$cache" --output json \
  ${pin_args[@]+"${pin_args[@]}"} \
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

# THE PIN FROM THE PUSH'S OWN ANSWER, never from its human text: `pinned` is
# null when no pin was asked for, and `{name, rootPaths}` when one was moved.
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

# THE EXIT STATUS IS THE PUSH'S OWN VERDICT, and a JSON that parses is not a
# permission to ignore it: a command that failed has not pushed, whatever the
# counts say.
if [ "$status" -ne 0 ] || [ "$failed" != "0" ]; then
  fail "odu push: \`odu cache push\` exited $status with $failed refused path(s) — the push did not land."
fi

# WHAT HAPPENED TO THE PIN, said where the step says what it did. A pin that
# was asked for and did not come back is red: `odu cache push` pins whenever
# every path landed, and nothing lands past the check above without having.
if [ -n "$pinned_name" ]; then
  say "odu push: the pin \"$pinned_name\" now holds $pinned_paths path(s)"
  summary "**Pinned:** \`$pinned_name\` now holds $pinned_paths path(s) — this closure stays out of garbage collection until a later push of this ref, on this system, moves the pin."
elif [ -n "$pin_requested" ]; then
  fail "odu push: \`--pin $pin_requested\` was asked for and \`odu cache push\` answered no pin — the closure is pushed but nothing holds it."
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
