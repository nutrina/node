# Patched Node.js images

Docker images that start from the official [Node.js image](https://hub.docker.com/_/node) and clear the vulnerabilities Grype can actually fix. CI builds each flavor, scans that image with Grype, and publishes it to Docker Hub only when the scan passes.

```dockerfile
FROM nutrina/node:24.22.2-bookworm-slim
```

The images keep the official entrypoint, command, and root user, so they can replace `node:24.22.2-alpine` and `node:24.22.2-bookworm-slim`.

The same pipeline also publishes patched Alpine images of two other official images, `nutrina/nginx` and `nutrina/golang` (see [Other images](#other-images)).

## Flavors

`flavors.json` is the list CI builds. Every entry pins the official patch release.

| Published image | Official base |
| --- | --- |
| `nutrina/node:24.22.2-alpine` | `node:24.22.2-alpine` |
| `nutrina/node:24.22.2-bookworm-slim` | `node:24.22.2-bookworm-slim` |
| `nutrina/nginx:1.31.8-alpine-slim` | `nginx:1.31.8-alpine-slim` |
| `nutrina/golang:1.27.3-alpine` | `golang:1.27.3-alpine` |

Each publish also pushes a date tag, such as `nutrina/node:24.22.2-bookworm-slim-20261029`. The version tag moves when that Node release is rebuilt with newer packages. The date tag stays on that build.

Images are published for `linux/amd64` and `linux/arm64`.

## What the build changes

The Dockerfile runs `scripts/patch-image.js`.

1. It upgrades distro packages (`apt-get upgrade` on Debian, `apk upgrade` on Alpine).
2. It installs the npm version in `patches.json` when the base image has an older npm. Node 24.22.2 ships npm 11.19.1. The pin is npm 11.21.1.
3. It replaces the bundled npm dependencies named in `patches.json` with those exact versions, staying on the same major and never downgrading a newer copy.

`/etc/node-image-patch.json` records the npm version and package versions that ended up in the image.

On 29 October 2026, Grype 0.121.0 reported these fixable findings in the official images. The rest were distro packages Debian or Alpine will not fix, and `apt-get` / `apk` had nothing newer to install that day.

| Official image | Fixable findings | After this patch |
| --- | --- | --- |
| `node:24.22.2-bookworm-slim` (npm 11.19.1) | 17, all in npm | 0 |
| `node:24.22.2-alpine` (npm 11.19.1) | 17, all in npm | 0 |

Upgrading to npm 11.21.1 cleared every fixable package on the Bookworm image except `undici@6.29.0` and `ip-address@10.7.2`. `patches.json` pins those to `6.29.1` and `10.7.4`. Alpine gets the same pins.

Grype still lists High findings in packages such as glibc, perl, ncurses, and busybox. Those are marked wont-fix or have no fixed package, so a rebuild cannot clear them. The CI gate fails on fixable findings at medium or above. The full report is uploaded as a workflow artifact.

## Other images

A flavor with `image`, `base` and `dockerfile` is not Node. It is built from `apk.Dockerfile`, which takes the official image (`BASE_IMAGE`) and runs `apk upgrade`, and nothing else: there is no npm to patch and no Node to run `scripts/patch-image.js`. `/etc/apk-image-patch.txt` lists what was upgraded.

Alpine often publishes a fix days before the official image is rebuilt with it. On 7 November 2026, every `nginx:*-alpine*` and `golang:*-alpine` tag still shipped zlib 1.3.2-r1 (CVE-2026-4738, critical), while Alpine already had 1.4-r0. These flavors close that gap. The scan and the push are the same as for Node. `smoke` chooses the smoke test: `nginx` serves its welcome page, `go` builds and runs a binary.

```json
{"tag": "1.31.8-alpine-slim", "image": "nutrina/nginx", "base": "nginx:1.31.8-alpine-slim", "dockerfile": "apk.Dockerfile", "smoke": "nginx", "aliases": []}
```

The rules in `.grype.yaml` are npm's, so on these images they match nothing and `check-ignored-fixes.js` warns, as it does for any flavor a rule does not apply to.

The first push of `nutrina/nginx` and `nutrina/golang` creates those Docker Hub repositories. `DOCKERHUB_TOKEN` needs write access to them, which a token scoped to `nutrina/node` alone does not have.

## CI

`.github/workflows/images.yml` runs on pull requests, on pushes to `main`, every Monday at 06:00 UTC, and on manual dispatch.

Each flavor is built once, for `linux/amd64` and `linux/arm64`, into an OCI archive. Grype scans every platform in that archive before anything is published. The Grype version and the failing severity are `grype` and `failOn` in `flavors.json`. The job fails when any platform has a fixable finding at medium or above.

After the scan passes, CI loads the amd64 image from the same archive and runs the smoke test (`node`, `npm`, and a real `npm install` as the `node` user). The push copies that archive to Docker Hub. It does not build the image again, and it checks that the scan wrote its pass marker. A failed scan or a failed smoke test skips the push. Pull requests build and scan, and they do not push. The Grype reports are uploaded as workflow artifacts.

A merge to `main` does not build the image again when a pull request already built it. Pull request runs from branches in this repository upload the tested OCI archive for 7 days. Its name includes a hash of the build inputs: the flavor's Dockerfile, `.dockerignore`, `patches.json`, `scripts/patch-image.js`, the flavor's `image`, `tag`, `nodeTag` and `base`, and the platforms. A push to `main` looks for an archive with the same hash and uses it in place of a build. It still scans that archive with the current Grype database, runs the ignored-advisory check and the smoke test, and only then pushes. The summary links the run that built it. When no archive matches, for example after it expired or a commit on `main` changed an input, `main` builds as before. Archives from forks are never used. Scheduled and manual runs always build, to pick up new base images and distro updates. A reused image's `org.opencontainers.image.revision` label is the pull request commit it was built from.

Each image job writes its tags to the run's summary page. On `main`, the summary lists every published tag with the digest of the pushed image and a `docker pull` command pinned to that digest. On pull requests, it lists the tags a merge would publish.

Publishing needs a repository variable and a repository secret:

- `DOCKERHUB_USERNAME`, a variable. It is not a secret on purpose: GitHub masks secret values in logs and summaries, and the username is part of every image name.
- `DOCKERHUB_TOKEN`, a secret: a Docker Hub access token with write access

The published repository name is the `image` field in `flavors.json`.

## Add a flavor

Add an object to `flavors.json`. `nodeTag` is the official tag. `tag` is the name published here. `aliases` are extra names on the same image.

```json
{"tag": "24.22.2-alpine", "nodeTag": "24.22.2-alpine", "aliases": []}
```

## Update the pins

When the Grype step fails, it prints the package, the installed version, and the fixed version. Put the fixed version in `patches.json` when it is the same major. When the fix is only on a newer major, move the `npm` pin instead and rebuild. A pin is skipped when the base image is already newer, and the build fails when the only installed copy is a different major.

## Ignored advisories

Some fixes cannot be applied yet. For example, the fixed version may be on a new major that npm does not bundle, and `patch-image.js` will not swap npm's copy to a new major. Those advisories go in `.grype.yaml`, which every scan uses. Each rule names the advisory, the package, and the location, so the same advisory in any other package still fails the gate.

| Advisory | Package | Why it is ignored |
| --- | --- | --- |
| GHSA-3g3m-2fjr-6pw4 | `glob` 13 bundled with npm | Fixed only in glob 14.0.2. npm 11.21.2 and 12.2.2 still bundle glob 13. |
| GHSA-g3hv-75wg-m249 | `minimatch` 10 bundled with npm | Fixed only in minimatch 11.0.1. npm 11.21.2 and 12.2.2 still bundle minimatch 10. |

After the scan, CI runs `scripts/check-ignored-fixes.js`. It fails the job before the push when an ignored advisory has a fix this repo can apply:

- the advisory lists a fixed version on the installed major, so the fix can go in `patches.json`, or
- the finding is inside npm, and a newer npm release bundles only fixed copies. The releases checked are the latest on the pinned npm major and npm's `latest` tag.

The log and the job summary name the fix to apply. Apply it and remove the rule from `.grype.yaml` in the same change. A rule that matches nothing in a flavor gets a warning, not a failure, because the rules are shared across flavors.

Build one flavor locally:

```sh
docker build --build-arg NODE_TAG=24.22.2-bookworm-slim -t nutrina/node:24.22.2-bookworm-slim .
docker run --rm nutrina/node:24.22.2-bookworm-slim node -p process.version
docker run --rm nutrina/node:24.22.2-bookworm-slim cat /etc/node-image-patch.json
```

`NODE_TAG` defaults to `24.22.2-bookworm-slim`.
