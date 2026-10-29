# syntax=docker/dockerfile:1

# Patched Node.js image. The official tag is the build arg, so one Dockerfile
# covers every flavor listed in flavors.json:
#   docker build --build-arg NODE_TAG=24.22.2-bookworm-slim -t nutrina/node:24.22.2-bookworm-slim .
#
# The build upgrades distro packages and replaces the npm dependencies named
# in patches.json. Entrypoint, command, and the default root user stay as they
# are on the official image.

ARG NODE_TAG=24.22.2-bookworm-slim
FROM node:${NODE_TAG}

ARG NODE_TAG

LABEL org.opencontainers.image.source="https://github.com/nutrina/node" \
      org.opencontainers.image.url="https://github.com/nutrina/node" \
      org.opencontainers.image.description="Node.js image with distro security updates and patched npm dependencies" \
      org.opencontainers.image.licenses="BSD-3-Clause" \
      org.opencontainers.image.base.name="docker.io/library/node:${NODE_TAG}"

USER root

COPY patches.json /tmp/node-patch/patches.json
COPY scripts/patch-image.js /tmp/node-patch/patch-image.js

RUN node /tmp/node-patch/patch-image.js /tmp/node-patch/patches.json "${NODE_TAG}" \
    && rm -rf /tmp/node-patch /root/.npm

ARG IMAGE_REVISION=unknown
LABEL org.opencontainers.image.revision="${IMAGE_REVISION}"
