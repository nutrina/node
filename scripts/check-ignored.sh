#!/usr/bin/env bash
# Fails when an advisory ignored in .grype.yaml has a fix this repo can apply.
# Converts the ignore rules to JSON and runs scripts/check-ignored-fixes.js on
# the full Grype reports that scripts/scan-image.sh wrote.
#
#   scripts/check-ignored.sh <grype-full-report.json>...
#
# Uses yq when installed, and the mikefarah/yq image otherwise.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "$#" -gt 0 ] || { echo "usage: check-ignored.sh <grype-full-report.json>..." >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
rules="${tmp}/grype-ignore-rules.json"

if command -v yq >/dev/null 2>&1; then
  yq -o=json '.ignore // []' "$root/.grype.yaml" > "$rules"
else
  docker run --rm -i mikefarah/yq:4 -o=json '.ignore // []' < "$root/.grype.yaml" > "$rules"
fi

node "$root/scripts/check-ignored-fixes.js" "$rules" "$root/patches.json" "$@"
