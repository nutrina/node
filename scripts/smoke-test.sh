#!/usr/bin/env bash
# Runs what a flavor's image is for: Node runs npm install, nginx serves a page,
# Go builds a binary. A version check alone would pass on an image whose upgrade
# broke the program. The flavor's `smoke` field in flavors.json picks the test.
#
#   scripts/smoke-test.sh <flavor-tag> <image>
#
# <flavor-tag> is a `tag` from flavors.json. <image> is the local image to run.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tag="${1:?usage: smoke-test.sh <flavor-tag> <image>}"
image="${2:?usage: smoke-test.sh <flavor-tag> <image>}"

flavor="$(jq -c --arg t "$tag" '.flavors[] | select(.tag == $t)' "$root/flavors.json")"
[ -n "$flavor" ] || { echo "no flavor with tag ${tag} in flavors.json" >&2; exit 1; }
smoke="$(jq -r '.smoke // "node"' <<< "$flavor")"

case "$smoke" in
  node)
    expected="$(jq -r '.nodeTag' <<< "$flavor")"
    expected="v${expected%%-*}"
    docker run --rm "$image" node -e "if (process.version !== '${expected}') { console.error(process.version); process.exit(1) } console.log(process.version)"
    docker run --rm "$image" npm --version
    docker run --rm --user node "$image" sh -c 'mkdir -p "$HOME/app" && cd "$HOME/app" && npm init -y >/dev/null && npm install --silent left-pad@1.0.0 && node -e "if (require(\"left-pad\")(\"x\", 3) !== \"  x\") process.exit(1)"'
    ;;
  nginx)
    expected="nginx/${tag%%-*}"
    docker run --rm "$image" nginx -v 2>&1 | tee /dev/stderr | grep -qx "nginx version: ${expected}"
    # Any free port, so it does not clash with something already on 8080.
    container=$(docker run -d --rm -p 127.0.0.1::80 "$image")
    trap 'docker stop "$container" >/dev/null' EXIT
    port=$(docker port "$container" 80/tcp | head -1 | sed 's/.*://')
    for _ in $(seq 1 30); do curl -fsS -o /dev/null "http://127.0.0.1:${port}/" && break; sleep 1; done
    curl -fsS "http://127.0.0.1:${port}/" | grep -q "Welcome to nginx"
    ;;
  go)
    expected="go${tag%%-*}"
    docker run --rm "$image" go version | tee /dev/stderr | grep -q "^go version ${expected} "
    docker run --rm "$image" sh -c 'mkdir /tmp/smoke && cd /tmp/smoke && go mod init smoke >/dev/null 2>&1 && printf "package main\n\nfunc main() { println(\"ok\") }\n" > main.go && CGO_ENABLED=0 go build -o smoke . && ./smoke'
    ;;
  *) echo "unknown smoke test: ${smoke}" >&2; exit 1 ;;
esac

echo "Smoke test passed: ${image} (${smoke})"
