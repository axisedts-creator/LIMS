# syntax=docker/dockerfile:1
# apps/web image (T0D-DEP-01, LD-173; C0 02-TRD s1.1 row 0D; C1 builds it as-is).
# Build context is the repo root:  docker build -f apps/web/Dockerfile --build-arg NODE_BASE_IMAGE=<image>@sha256:<digest> .
# `next build` in a full-install stage, `next start` in the final stage with production dependencies only.
# next.config.mjs is unchanged (no standalone output).
#
# Base image (CV s1.1): the exact Node patch of package.json engines, pinned by digest. LD-173 rule 1: no default here,
# so a build without --build-arg NODE_BASE_IMAGE fails; C1 ci/build.sh passes the digest from its lock files.
# Read the digest with: docker buildx imagetools inspect <image>:<tag>
ARG NODE_BASE_IMAGE

# ---- build: full install (next build needs typescript and yaml for build:nav), then next build
FROM ${NODE_BASE_IMAGE} AS build
WORKDIR /app
# [CONV] pnpm version = root package.json packageManager (pnpm@12.18.0); keep the two equal (the T0D-DEP-01 test checks it).
RUN npm install -g pnpm@12.18.0 --ignore-scripts
# Whole repo minus .dockerignore (no .git, spec, .orchestra, .env*, keys); pnpm-lock.yaml and every workspace manifest included.
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @lims/web build

# ---- deps: production dependencies only, from pnpm-lock.yaml (--frozen-lockfile)
FROM ${NODE_BASE_IMAGE} AS deps
WORKDIR /app
RUN npm install -g pnpm@12.18.0 --ignore-scripts
COPY . .
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# ---- runtime
FROM ${NODE_BASE_IMAGE} AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/apps/web/package.json /app/apps/web/next.config.mjs ./apps/web/
COPY --from=build /app/apps/web/.next ./apps/web/.next
# Read-only root filesystem (REQ-SEC-130). The only writable path is /tmp (mount a tmpfs: docker run --read-only --tmpfs /tmp):
# Next's runtime cache dir apps/web/.next/cache is replaced by a symlink to /tmp, so cache writes land under /tmp.
RUN rm -rf /app/apps/web/.next/cache && ln -s /tmp /app/apps/web/.next/cache
WORKDIR /app/apps/web
# LD-173 rule 3: numeric non-root user (no passwd entry needed); files stay root-owned and read-only for it.
USER 10001:10001
# The web image listens on port 3000 (next start -p 3000, all interfaces). No Docker socket mount, no VOLUME.
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
