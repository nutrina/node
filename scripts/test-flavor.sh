#!/usr/bin/env bash
# Builds one flavor locally and runs the same checks as CI: the Grype scan, the
# ignored-advisory check, the smoke test and, for Go flavors, govulncheck.
# Nothing is pushed.
#
#   scripts/test-flavor.sh [options] [flavor-tag...]
#
# With no tag, every flavor in flavors.json is tested.
#
# Options:
#   --all-platforms   Build and scan every platform in flavors.json. The default
#                     is only this machine's platform, which is much faster.
#   --platform <p>    Build and scan these platforms (comma-separated).
#   --skip-build      Reuse the archive from the last run of this flavor.
#   --skip-scan       Skip the Grype scan and the ignored-advisory check.
#   --skip-smoke      Skip the smoke test.
#   --skip-govulncheck  Skip govulncheck on Go flavors.
#   --out <dir>       Where archives and reports go (default: .local-test).
#
# Needs docker with buildx and the containerd image store (the Docker Desktop
# default), grype, jq and node. yq is optional.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${root}/.local-test"
platforms=""
build=1 scan=1 smoke=1 govuln=1
tags=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --all-platforms) platforms="$(jq -r '.platforms | join(",")' "$root/flavors.json")" ;;
    --platform) platforms="${2:?--platform needs a value}"; shift ;;
    --skip-build) build=0 ;;
    --skip-scan) scan=0 ;;
    --skip-smoke) smoke=0 ;;
    --skip-govulncheck) govuln=0 ;;
    --out) out="${2:?--out needs a value}"; shift ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 1 ;;
    *) tags+=("$1") ;;
  esac
  shift
done

case "$(uname -m)" in
  arm64|aarch64) native=linux/arm64 ;;
  *) native=linux/amd64 ;;
esac
platforms="${platforms:-$native}"
# The smoke test runs on this machine's platform when it was built, else the first one.
if [[ ",${platforms}," == *",${native},"* ]]; then
  run_platform="$native"
else
  run_platform="${platforms%%,*}"
fi

for tool in docker jq node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing: $tool" >&2; exit 1; }
done
if [ "$scan" -eq 1 ]; then
  command -v grype >/dev/null 2>&1 || { echo "missing: grype (brew install grype)" >&2; exit 1; }
fi

if [ "${#tags[@]}" -eq 0 ]; then
  while IFS= read -r t; do tags+=("$t"); done < <(jq -r '.flavors[].tag' "$root/flavors.json")
fi

default_image="$(jq -r '.image' "$root/flavors.json")"
revision="$(git -C "$root" rev-parse HEAD 2>/dev/null || echo local)"
passed=() failed=()

test_flavor() {
  local tag="$1"
  local flavor image dockerfile dir archive local_image
  flavor="$(jq -c --arg t "$tag" '.flavors[] | select(.tag == $t)' "$root/flavors.json")"
  [ -n "$flavor" ] || { echo "no flavor with tag ${tag} in flavors.json" >&2; return 1; }
  image="$(jq -r --arg d "$default_image" '.image // $d' <<< "$flavor")"
  dockerfile="$(jq -r '.dockerfile // "Dockerfile"' <<< "$flavor")"
  dir="${out}/${image//\//-}-${tag}"
  archive="${dir}/oci-image.tar"
  local_image="local/image:${tag}"
  mkdir -p "$dir"

  echo
  echo "=== ${image}:${tag} (${platforms}) ==="

  if [ "$build" -eq 1 ]; then
    rm -f "$dir"/grype-*
    docker buildx build "$root" \
      --file "$root/$dockerfile" \
      --pull \
      --platform "$platforms" \
      --build-arg "NODE_TAG=$(jq -r '.nodeTag // ""' <<< "$flavor")" \
      --build-arg "BASE_IMAGE=$(jq -r '.base // ""' <<< "$flavor")" \
      --build-arg "IMAGE_REVISION=${revision}" \
      --provenance=false --sbom=false \
      --output "type=oci,dest=${archive}" || return 1
  fi
  [ -f "$archive" ] || { echo "no archive at ${archive}. Run without --skip-build." >&2; return 1; }

  if [ "$scan" -eq 1 ]; then
    echo "--- Grype scan"
    "$root/scripts/scan-image.sh" "$archive" "$dir" "$platforms" || return 1
    echo "--- Ignored advisories"
    "$root/scripts/check-ignored.sh" "$dir"/grype-full-*.json || return 1
  fi

  local is_go=0
  [ "$(jq -r '.smoke // "node"' <<< "$flavor")" = go ] && is_go=1

  if [ "$smoke" -eq 1 ] || { [ "$govuln" -eq 1 ] && [ "$is_go" -eq 1 ]; }; then
    # Load the archive that was scanned, not a fresh build.
    local loaded
    loaded="$(docker load --platform "$run_platform" -i "$archive" | sed -n 's/^Loaded image ID: //p; s/^Loaded image: //p' | tail -1)"
    [ -n "$loaded" ] || { echo "docker load did not report an image" >&2; return 1; }
    docker tag "$loaded" "$local_image" || return 1
  fi

  if [ "$smoke" -eq 1 ]; then
    echo "--- Smoke test (${run_platform})"
    "$root/scripts/smoke-test.sh" "$tag" "$local_image" || return 1
  fi

  if [ "$govuln" -eq 1 ] && [ "$is_go" -eq 1 ]; then
    echo "--- govulncheck (${run_platform})"
    "$root/scripts/govulncheck.sh" "$local_image" "$dir" || return 1
  fi

  echo "Reports in ${dir}"
}

for tag in "${tags[@]}"; do
  if test_flavor "$tag"; then passed+=("$tag"); else failed+=("$tag"); fi
done

echo
echo "=== Summary ==="
for t in ${passed[@]+"${passed[@]}"}; do echo "PASS  $t"; done
for t in ${failed[@]+"${failed[@]}"}; do echo "FAIL  $t"; done
[ "${#failed[@]}" -eq 0 ]
