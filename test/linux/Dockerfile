# Linux test bed: Node 22 + Debian Chromium, no desktop, running as root (so --no-sandbox applies).
#   docker build -t magpie-muse-web-linux-test test/linux
#   docker run --rm -v "$PWD:/plugin:ro" -w /plugin magpie-muse-web-linux-test node --test contract.test.mjs "test/*.test.mjs"
# Behind a proxy, add --build-arg http_proxy=... --build-arg https_proxy=... to the build.
FROM node:22-bookworm-slim
ARG http_proxy
ARG https_proxy
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*
