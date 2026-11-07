# syntax=docker/dockerfile:1

# Patched Alpine image of an official tag that is not Node: the official image with Alpine's
# security updates applied. One Dockerfile covers every flavor in flavors.json that names it:
#   docker build -f apk.Dockerfile --build-arg BASE_IMAGE=nginx:1.31.8-alpine-slim -t nutrina/nginx:1.31.8-alpine-slim .
#
# Only `apk upgrade`: these images have no npm to patch, and no Node to run scripts/patch-image.js.
# Alpine often publishes a fix days before the official image is rebuilt with it (zlib 1.4-r0 for
# CVE-2026-4738 on 2026-11-07), and that gap is what this closes. Entrypoint, command, user and
# working directory stay as the official image has them.

ARG BASE_IMAGE=nginx:1.31.8-alpine-slim
FROM ${BASE_IMAGE}

ARG BASE_IMAGE

LABEL org.opencontainers.image.source="https://github.com/nutrina/node" \
      org.opencontainers.image.url="https://github.com/nutrina/node" \
      org.opencontainers.image.description="Official image with Alpine security updates applied" \
      org.opencontainers.image.base.name="docker.io/library/${BASE_IMAGE}"

# The official nginx and golang images run as root by default; USER is not changed, so the
# image stays a drop-in replacement. /etc/apk-image-patch.txt records what was upgraded.
RUN apk upgrade --no-cache --simulate 2>/dev/null | sed -n 's/^(.*) Upgrading //p' > /etc/apk-image-patch.txt \
    && apk upgrade --no-cache \
    && cat /etc/apk-image-patch.txt

ARG IMAGE_REVISION=unknown
LABEL org.opencontainers.image.revision="${IMAGE_REVISION}"
