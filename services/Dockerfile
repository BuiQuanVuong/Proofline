# Proofline test runner (design-doc §6.2, D5, D8).
# Build from the repository root:
#   docker build --platform linux/amd64 -f services/Dockerfile -t proofline-runner .
#
# One image per registered repository: the repo's dependencies are installed at
# build time, so no job ever installs packages (or runs install scripts) at run time.

# ECR Public mirror of the official image: avoids Docker Hub pull limits from the NAT.
FROM public.ecr.aws/docker/library/node:22-bookworm-slim

WORKDIR /app

# Engine and services: production dependencies only, lockfile-exact.
COPY engine/package.json engine/package-lock.json engine/
RUN cd engine && npm ci --omit=dev --no-audit --no-fund
COPY engine/src engine/src

COPY services/package.json services/package-lock.json services/
RUN cd services && npm ci --omit=dev --no-audit --no-fund
COPY services/src services/src
COPY services/bin services/bin

# Registered repository: the fixture project (vitest + coverage are dev
# dependencies there, and they're exactly what the runner needs).
COPY engine/test/fixture-project/package.json engine/test/fixture-project/package-lock.json /opt/deps/fixture/
RUN cd /opt/deps/fixture && npm ci --include=dev --no-audit --no-fund
# Dependencies stay root-owned, so untrusted test code can't tamper with
# packages that later jobs on the same task reuse. Only the cache folders
# Vitest/Vite write inside node_modules are writable by the runtime user.
RUN mkdir -p /opt/deps/fixture/node_modules/.vitest-cache /opt/deps/fixture/node_modules/.vite \
 && chown node:node /opt/deps/fixture/node_modules/.vitest-cache /opt/deps/fixture/node_modules/.vite

ENV NODE_ENV=production \
    PROOFLINE_DEPS_DIR=/opt/deps/fixture \
    PROOFLINE_WORK_ROOT=/tmp/proofline-work

# Untrusted test code runs as the unprivileged image user, never root.
USER node
CMD ["node", "/app/services/bin/runner.js"]
