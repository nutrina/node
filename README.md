# Patched Node.js images

Docker images that start from the official [Node.js image](https://hub.docker.com/_/node) and clear the vulnerabilities Grype can actually fix. CI builds each flavor, scans that image with Grype, and publishes it to Docker Hub only when the scan passes.

```dockerfile
FROM nutrina/node:24.22.2-bookworm-slim
```

The images keep the official entrypoint, command, and root user, so they can replace `node:24.22.2-alpine` and `node:24.22.2-bookworm-slim`.

## Flavors

`flavors.json` is the list CI builds. Both entries pin the official patch release.

| Published tag | Official base |
| --- | --- |
| `24.22.2-alpine` | `node:24.22.2-alpine` |
| `24.22.2-bookworm-slim` | `node:24.22.2-bookworm-slim` |

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

## CI

`.github/workflows/images.yml` runs on pull requests, on pushes to `main`, every Monday at 06:00 UTC, and on manual dispatch.

Each flavor is built once, for `linux/amd64` and `linux/arm64`, into an OCI archive. Grype scans every platform in that archive before anything is published. The Grype version and the failing severity are `grype` and `failOn` in `flavors.json`. The job fails when any platform has a fixable finding at medium or above.

After the scan passes, CI loads the amd64 image from the same archive and runs the smoke test (`node`, `npm`, and a real `npm install` as the `node` user). The push copies that archive to Docker Hub. It does not build the image again, and it checks that the scan wrote its pass marker. A failed scan or a failed smoke test skips the push. Pull requests build and scan, and they do not push. The Grype reports are uploaded as workflow artifacts.

Publishing needs two repository secrets:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`, a Docker Hub access token with write access

The published repository name is the `image` field in `flavors.json`.

## Add a flavor

Add an object to `flavors.json`. `nodeTag` is the official tag. `tag` is the name published here. `aliases` are extra names on the same image.

```json
{"tag": "24.22.2-alpine", "nodeTag": "24.22.2-alpine", "aliases": []}
```

## Update the pins

When the Grype step fails, it prints the package, the installed version, and the fixed version. Put the fixed version in `patches.json` when it is the same major. When the fix is only on a newer major, move the `npm` pin instead and rebuild. A pin is skipped when the base image is already newer, and the build fails when the only installed copy is a different major.

Build one flavor locally:

```sh
docker build --build-arg NODE_TAG=24.22.2-bookworm-slim -t nutrina/node:24.22.2-bookworm-slim .
docker run --rm nutrina/node:24.22.2-bookworm-slim node -p process.version
docker run --rm nutrina/node:24.22.2-bookworm-slim cat /etc/node-image-patch.json
```

`NODE_TAG` defaults to `24.22.2-bookworm-slim`.
