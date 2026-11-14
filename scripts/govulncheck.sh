#!/usr/bin/env bash
# Scans the Go toolchain binaries in a Go image with govulncheck and fails when
# a binary calls a vulnerable function that has a fixed release. CI runs this
# for flavors with "smoke": "go" before the push; scripts/test-flavor.sh runs it
# locally.
#
#   scripts/govulncheck.sh <image> [out-dir]
#
# govulncheck (the version is `govulncheck` in flavors.json) is installed and run
# inside the image, so the host needs no Go. It needs network access to fetch
# govulncheck and the Go vulnerability database.
#
# Writes govulncheck-<binary>.json to out-dir (default: the current directory).
#
# Only findings in a function the binary calls, with a fixed version, fail.
# The fix is usually a newer Go patch release: move the flavor's tag and base in
# flavors.json to it. Findings the binary does not call, or that have no fix,
# are listed and do not fail.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${1:?usage: govulncheck.sh <image> [out-dir]}"
out="${2:-.}"
version="$(jq -r '.govulncheck // empty' "$root/flavors.json")"
[ -n "$version" ] || { echo "set govulncheck in flavors.json" >&2; exit 1; }
mkdir -p "$out"
rm -f "$out"/govulncheck-*.json

echo "Scanning Go binaries in ${image} with govulncheck ${version}"
# The reports come back as a tar on stdout, so nothing in the container writes
# to the host and no file ends up owned by root.
docker run --rm --entrypoint sh -e "GOVULNCHECK_VERSION=${version}" "$image" -c '
  set -eu
  export GOBIN=/tmp/govulncheck-bin GOFLAGS=
  go install "golang.org/x/vuln/cmd/govulncheck@${GOVULNCHECK_VERSION}" >&2
  mkdir -p /tmp/govulncheck-out
  goroot="$(go env GOROOT)"
  for bin in "$goroot"/bin/* "$goroot"/pkg/tool/*/*; do
    [ -f "$bin" ] && [ -x "$bin" ] || continue
    echo "  $bin" >&2
    "$GOBIN/govulncheck" -mode=binary -format json "$bin" > "/tmp/govulncheck-out/govulncheck-$(basename "$bin").json"
  done
  tar -C /tmp/govulncheck-out -cf - .
' | tar -C "$out" -xf -

reports=("$out"/govulncheck-*.json)
[ -f "${reports[0]}" ] || { echo "govulncheck wrote no reports" >&2; exit 1; }

# One line per advisory, module and binary. `called` means the first trace
# frame names a function, which is govulncheck's symbol level.
findings="$(
  for report in "${reports[@]}"; do
    bin="$(basename "$report" .json)"
    bin="${bin#govulncheck-}"
    jq -r --arg bin "$bin" '
      select(.finding) | .finding
      | [.osv, "\(.trace[0].module)@\(.trace[0].version)", (.fixed_version // ""),
         (if .trace[0].function then "called" else "not-called" end), $bin]
      | @tsv
    ' "$report"
  done | sort -u \
    | awk -F'\t' 'BEGIN { OFS = "\t" } {
        # govulncheck reports an advisory at module, package and function
        # level. Keep one row per binary, called when any row is.
        key = $1 OFS $2 OFS $3 OFS $5
        if (!(key in level)) order[++n] = key
        if ($4 == "called" || !(key in level)) level[key] = $4
      } END {
        for (i = 1; i <= n; i++) { split(order[i], f, OFS); print f[1], f[2], f[3], level[order[i]], f[4] }
      }'
)"

blocking="$(awk -F'\t' '$3 != "" && $4 == "called"' <<< "$findings")"
other="$(awk -F'\t' '!($3 != "" && $4 == "called")' <<< "$findings" | awk 'NF')"

summarize() {
  # advisory, module, fixed version, binaries
  awk -F'\t' '{
    key = $1 "\t" $2 "\t" ($3 == "" ? "no fix" : "fixed in " $3)
    if (!(key in bins)) { order[++n] = key; bins[key] = $5 }
    else if (index("," bins[key] ",", "," $5 ",") == 0) bins[key] = bins[key] "," $5
  } END { for (i = 1; i <= n; i++) print order[i] "\t" bins[order[i]] }'
}

if [ -n "$other" ]; then
  echo "Not failing (not called by the binary, or no fixed version):"
  summarize <<< "$other" | sed 's/^/  /'
fi

if [ -z "$blocking" ]; then
  echo "govulncheck: no called vulnerability with a fix."
  exit 0
fi

echo "Called vulnerabilities with a fix:"
summarize <<< "$blocking" | sed 's/^/  /'
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### govulncheck: ${image}"
    echo
    echo "| Advisory | Module | Fix | Binaries |"
    echo "| --- | --- | --- | --- |"
    summarize <<< "$blocking" | awk -F'\t' '{ printf "| [%s](https://pkg.go.dev/vuln/%s) | `%s` | %s | %s |\n", $1, $1, $2, $3, $4 }'
    echo
  } >> "$GITHUB_STEP_SUMMARY"
fi
echo "Move the flavor to a Go release with the fix (tag and base in flavors.json)." >&2
exit 1
