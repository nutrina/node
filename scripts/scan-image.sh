#!/usr/bin/env bash
# Scans every platform in an OCI archive with Grype and fails on fixable
# findings at or above `failOn` in flavors.json. CI runs this before the push;
# scripts/test-flavor.sh runs it locally.
#
#   scripts/scan-image.sh <oci-archive> [out-dir] [platform,...]
#
# Writes grype-fixed-<platform>.json, grype-full-<platform>.json and
# grype-<platform>.sarif to out-dir (default: the current directory). The
# platforms default to `platforms` in flavors.json.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
archive="${1:?usage: scan-image.sh <oci-archive> [out-dir] [platform,...]}"
out="${2:-.}"
platform_list="${3:-$(jq -r '.platforms | join(",")' "$root/flavors.json")}"
fail_on="$(jq -r '.failOn' "$root/flavors.json")"
want_grype="$(jq -r '.grype' "$root/flavors.json")"

[ -f "$archive" ] || { echo "no such archive: $archive" >&2; exit 1; }
mkdir -p "$out"

have_grype="v$(grype version -o json | jq -r '.version')"
if [ "$have_grype" != "$want_grype" ]; then
  echo "WARN  Grype is ${have_grype}, flavors.json pins ${want_grype}. Results may differ from CI." >&2
fi

case "$fail_on" in
  critical) sevs='["Critical"]' ;;
  high) sevs='["High","Critical"]' ;;
  medium) sevs='["Medium","High","Critical"]' ;;
  *) echo "unknown failOn: $fail_on" >&2; exit 1 ;;
esac

failed=0
IFS=',' read -ra platforms <<< "$platform_list"
for platform in "${platforms[@]}"; do
  safe="${platform//\//-}"
  echo "Scanning ${platform}"
  grype "oci-archive:${archive}" -c "$root/.grype.yaml" --platform "$platform" --only-fixed -o json > "${out}/grype-fixed-${safe}.json"
  grype "oci-archive:${archive}" -c "$root/.grype.yaml" --platform "$platform" -o json > "${out}/grype-full-${safe}.json"
  grype "oci-archive:${archive}" -c "$root/.grype.yaml" --platform "$platform" --only-fixed -o sarif > "${out}/grype-${safe}.sarif"

  echo "Fixable findings at or above ${fail_on} for ${platform}:"
  jq -r --argjson sevs "$sevs" '
    .matches[]
    | select(.vulnerability.severity as $s | $sevs | index($s))
    | "\(.vulnerability.severity)\t\(.artifact.name)@\(.artifact.version)\t\(.vulnerability.id)\t\(.artifact.type)"
  ' "${out}/grype-fixed-${safe}.json" | sort -u

  count=$(jq -r --argjson sevs "$sevs" '
    [.matches[] | select(.vulnerability.severity as $s | $sevs | index($s))] | length
  ' "${out}/grype-fixed-${safe}.json")
  echo "${platform} count=${count}"
  if [ "$count" -gt 0 ]; then
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "Grype reported fixable vulnerabilities." >&2
  exit 1
fi
