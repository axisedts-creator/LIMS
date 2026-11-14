Title: CR-C0-0D-T0D-DEP-01: move `pg` from devDependencies to dependencies of services/api
From chunk: C0-0D            To owner: C0-0A
Type: shared-lib
Blocking? yes — T0D-DEP-01 API image: with LIMS_CORE_DATABASE_URL set (render.yaml, any real deploy) the API fails at boot.
Problem: services/api/src/core/pipeline/boot.ts:103-104 does `await import('pg')` when LIMS_CORE_DATABASE_URL is set, but
  `pg` is a devDependency of services/api (services/api/package.json:23, LD-05). The image installs production deps only
  (`pnpm install --frozen-lockfile --prod`, T0D-DEP-01 done_when), so `pg` is absent and boot rejects "Cannot find package 'pg'".
  Same for identity:bootstrap-platform-admin (bootstrap-platform-admin.ts:70).
Proposed change (exact): services/api/package.json: move `"pg": "8.23.1"` from devDependencies to dependencies; regenerate
  pnpm-lock.yaml (C0-0A owns it). `@types/pg` stays a devDependency.
Backward compatible? yes — same version, only the dependency class changes.
Tenant/security impact: none (no RLS, no PHI, no new surface); REQ-SEC-129 exact pin kept.
Alternatives considered: (a) final stage copies the dev install — violates "production dependencies only"; (b) pnpm
  node-linker=hoisted so graphile-worker's transitive pg resolves — relies on a transitive dep, unverified on pnpm 12.
Tests that will prove it: build services/api/Dockerfile, run with LIMS_CORE_DATABASE_URL + LIMS_CORE_RATELIMIT_KEY_FILE set;
  GET /health/live on 8080 answers. T0D-DEP-01 static tests stay green (no Dockerfile change needed).
