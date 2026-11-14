# syntax=docker/dockerfile:1
# services/api image (T0D-DEP-01, LD-173; C0 02-TRD s1.1 row 0D; C1 builds it as-is).
# Build context is the repo root:  docker build -f services/api/Dockerfile --build-arg NODE_BASE_IMAGE=<image>@sha256:<digest> .
# The API has no build step: Node runs src/main.ts directly. The final stage mirrors the repo layout under /app because
# src/core/module.ts REPO_ROOT resolves contracts/ and packages/fakes/ four levels above src/core.
#
# Base image (CV s1.1): the exact Node patch of package.json engines, pinned by digest. LD-173 rule 1: no default here,
# so a build without --build-arg NODE_BASE_IMAGE fails; C1 ci/build.sh passes the digest from its lock files.
# Read the digest with: docker buildx imagetools inspect <image>:<tag>
ARG NODE_BASE_IMAGE

# ---- deps: production dependencies only, from pnpm-lock.yaml (--frozen-lockfile)
FROM ${NODE_BASE_IMAGE} AS deps
WORKDIR /app
# [CONV] pnpm version = root package.json packageManager (pnpm@12.18.0); keep the two equal (the T0D-DEP-01 test checks it).
RUN npm install -g pnpm@12.18.0 --ignore-scripts
# Whole repo minus .dockerignore (no .git, spec, .orchestra, .env*, keys); pnpm-lock.yaml and every workspace manifest included.
COPY . .
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# ---- runtime
FROM ${NODE_BASE_IMAGE} AS runtime
# Read-only root filesystem (REQ-SEC-130): the API writes no file at run time. The only writable path is /tmp
# (mount a tmpfs there: docker run --read-only --tmpfs /tmp). No Docker socket mount, no VOLUME.
WORKDIR /app
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/contracts ./contracts
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/services/api ./services/api
WORKDIR /app/services/api
# LD-173 rule 3: numeric non-root user (no passwd entry needed); files stay root-owned and read-only for it.
USER 10001:10001
# src/main.ts listens on 0.0.0.0:8080 (fixed). /metrics + /health/live: LIMS_CORE_METRICS_PORT (default 9464, config.ts).
EXPOSE 8080
CMD ["node", "src/main.ts"]
