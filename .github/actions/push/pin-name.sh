#!/usr/bin/env bash

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
