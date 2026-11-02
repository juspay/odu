#!/usr/bin/env bash
#
# THE NAME A PUSHED CLOSURE'S PIN CARRIES, derived rather than typed.
#
#   pin-name.sh <owner/repo> <ref name> <system>
#   → juspay/kolu@master/x86_64-linux
#
# Three facts, and each one is in the name because leaving it out collides
# with somebody:
#
#   - THE REPOSITORY, because four projects share one `kolu` bucket. A pin
#     called `master` would be whichever of them pushed last.
#   - THE REF THAT WAS PUSHED (`github.ref_name`, or a pull request's head
#     branch), so the name says what the pin holds.
#   - THE SYSTEM, because every one of those workflows runs a MATRIX, and both
#     jobs push on the same commit. Under one shared name the second job to
#     finish re-points the pin and hands the first job's closure to the next
#     collection: Linux would evict macOS, or the reverse, every push.
#
# WHEN to pin is the workflow's decision and appears nowhere here — see the
# action's `pin:` input. Derived in its own script so the rule is one place
# and can be tested without a runner, a token or a network
# (`src/pushPin.test.ts`).

repository=${1:-}
ref=${2:-}
system=${3:-}

for part in "$repository" "$ref" "$system"; do
  if [ -z "$part" ]; then
    printf 'pin-name.sh: needs <owner/repo> <ref name> <system>\n' >&2
    exit 2
  fi
done

printf '%s@%s/%s\n' "$repository" "$ref" "$system"
