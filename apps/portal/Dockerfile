# syntax=docker/dockerfile:1
# apps/portal image (C6 patient portal BFF). Modelled on apps/web/Dockerfile (same stages, user and pins); CR-C1-902 item 7 (C6 to review).
# Build context is the repo root:  docker build -f apps/portal/Dockerfile --build-arg NODE_BASE_IMAGE=<image>@sha256:<digest> .
# `next build` in a full-install stage, `next start` in the final stage with production dependencies only.
# next.config.mjs is unchanged (no standalone output).
#
# Base image (CV s1.1): the exact Node patch of package.json engines, pinned by digest. LD-173 rule 1: no default here,
# so a build without --build-arg NODE_BASE_IMAGE fails; infra/ci/build.sh passes the digest from base-images.lock.
ARG NODE_BASE_IMAGE

# ---- build: full install, then next build (no build:nav step in apps/portal; next.config.mjs builds packages/ui/dist/tokens.css when missing)
FROM ${NODE_BASE_IMAGE} AS build
WORKDIR /app
# [CONV] pnpm version = root package.json packageManager (pnpm@12.18.0); keep the two equal.
RUN npm install -g pnpm@12.18.0 --ignore-scripts
# Whole repo minus .dockerignore (no .git, spec, .orchestra, .env*, keys); pnpm-lock.yaml and every workspace manifest included.
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @lims/portal build

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
# [CONV] tokens.css is a git-ignored build output that next.config.mjs checks at start-up; take the one the build stage made (read-only rootfs cannot regenerate it).
COPY --from=build /app/packages/ui/dist ./packages/ui/dist
COPY --from=deps /app/apps/portal/node_modules ./apps/portal/node_modules
COPY --from=deps /app/apps/portal/package.json /app/apps/portal/next.config.mjs ./apps/portal/
# [CONV] public/ holds /.well-known/apple-app-site-association and assetlinks.json, which `next start` serves from the working directory.
COPY --from=deps /app/apps/portal/public ./apps/portal/public
COPY --from=build /app/apps/portal/.next ./apps/portal/.next
# Read-only root filesystem (REQ-SEC-130). The only writable path is /tmp (mount a tmpfs: docker run --read-only --tmpfs /tmp):
# Next's runtime cache dir apps/portal/.next/cache is replaced by a symlink to /tmp, so cache writes land under /tmp.
RUN rm -rf /app/apps/portal/.next/cache && ln -s /tmp /app/apps/portal/.next/cache
WORKDIR /app/apps/portal
# LD-173 rule 3: numeric non-root user (no passwd entry needed); files stay root-owned and read-only for it.
USER 10001:10001
# The portal image listens on port 3000 (C1 02-TRD origin table `portal:3000`; nginx proxy_pass http://portal:3000), next start, all interfaces.
# The healthcheck is the compose one (infra/compose/lims/compose.app.yml `healthcheck: *bff-health`), as for web. No Docker socket mount, no VOLUME.
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
