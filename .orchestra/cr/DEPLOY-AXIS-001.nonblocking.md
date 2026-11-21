Title: CR-C1-DEPLOY-001: first real prod deploy (prod-lean, single host) found build and deploy defects
From chunk: C1 (deploy attempt, prod-lean inventory, 2026-11-20/21)    To owner: per item (listed below)
Type: bug
Blocking? yes for production go-live (web, renderer, portal images and the Supabase DB stack cannot start); no for any current orchestra task, so this file is named `.nonblocking`.

Evidence: unattended deploy runs on host "axis" (VM `lims`, Ansible `prod-lean`, repo commit b3ada5168). Report: `OVERNIGHT-REPORT.md` on axis (~/lims-deploy). Built OK on lims: api, worker, pdf-sandbox. Everything below is what stopped the rest.

## Items

### 1. web image build fails  (To: C4 billing, with C0-0D for the web shell)
Problem: `pnpm --filter @lims/web build` fails with `Error: 'server-only' cannot be imported from a Client Component module`.
Chain: `apps/web/src/features/billing/components/discounts/DiscountSlabsScreen.tsx` (client component) imports `features/billing/server/discounts.server.ts`, which imports `core/api/server-fetch.ts` and `core/session/server.ts` (both `server-only`).
Proposed change: make the screen a server component, or pass the data through a server action / route handler, so no client module imports a `*.server.ts` file. Add a CI step that runs `next build` so this cannot recur.
Backward compatible? yes.

### 2. renderer image build fails  (To: C6)
Problem: `services/renderer/Dockerfile.renderer`, three separate failures:
1. `corepack: not found` (base image Node 26 has no corepack). `Dockerfile.sandbox` already uses `npm install -g pnpm@<pinned>`; do the same.
2. `TS2307: Cannot find module '../../../../../packages/shared-ts/src/bsdate/index.js'`: the Dockerfile does not `COPY packages/shared-ts/`.
3. After copying it: `TS6059: File packages/shared-ts/src/bsdate/impl.ts is not under rootDir`, plus unresolved dependency `@remotemerge/nepali-date-converter` and `ERR_PNPM_IGNORED_BUILDS` (@scarf/scarf).
Proposed change: build `packages/shared-ts` as its own package (emit JS + d.ts) and depend on it from the renderer, or drop `rootDir`; declare the missing dependency in the owning package; allow or ignore the scarf build script explicitly in pnpm config.
Backward compatible? yes.

### 3. portal has no Dockerfile  (To: owner of `apps/portal`, see 01-CHUNK-MAP §3)
Problem: `compose.app.yml` references a portal image but `apps/portal` has no Dockerfile, so the app stack cannot start.
Proposed change: add the Dockerfile (pinned base digest, non-root user, same pattern as web/api) and a build target in the image build list.
Backward compatible? yes.

### 4. postgres-pgbackrest Dockerfile missing build dependency  (To: C1)
Problem: the builder stage lacks `py3-yaml`; pgBackRest 2.60 build fails with `ModuleNotFoundError: No module named 'yaml'`.
Proposed change: add `py3-yaml` to the apk line of the builder stage. Verified in a build copy (image built).
Backward compatible? yes.

### 5. No role starts the Supabase DB, GoTrue, Storage  (To: C1)
Problem: `infra/compose/supabase/DECISION.md` describes a manual recipe (upstream compose + `override.data.yml`, `up -d db pgbouncer`), but no Ansible role does it. `db-bootstrap.yml` and the Audit store play assume a container named `supabase-db` and fail with `No such container: supabase-db`.
Missing inputs, none rendered by any role:
- `zz-lims.conf`, `pg_hba.conf`, `pgbouncer.ini` (only `.j2` templates under `infra/database/postgresql` / pgbouncer);
- `/run/lims/secrets/pgbouncer/userlist.txt`;
- the upstream compose `.env` (POSTGRES_PASSWORD, JWT_SECRET, ANON_KEY, ...) rendered to tmpfs on the host;
- data path mismatch: compose expects `/srv/lims/pg/data`, `luks_volumes` mounts the DB volume at `/srv/lims/db`. Decision needed which path wins.
- `DB_IMAGE_DIGEST` comes from a release lock that does not exist on a fresh host; first deploy has no way to build and push the image (registry push credential is not generated or stored).
Proposed change: new role (e.g. `supabase_stack`) that renders the files above, renders the `.env` from sops to tmpfs, starts db, pgbouncer, GoTrue and Storage, and a documented first-deploy path for the release lock (local build then push, or a bootstrap flag that accepts a local image tag).
Backward compatible? yes (new role).

### 6. Audit store passwords missing from the secrets schema  (To: C1)
Problem: `audit_writer_password`, `audit_digest_password`, `audit_reader_password` are required by the Audit store play but are not in the secrets schema, so `secrets_generate.py` does not create them. Workaround used on prod: a side file `prod.audit.enc.yaml`.
Proposed change: add the three ids to the schema (random 48 chars) and to the generator; then fold the side file into `prod.enc.yaml`.
Backward compatible? yes (additive).

### 7. Secrets generation needs files the repo does not ship  (To: C1)
Problem:
- `infra/compose/supabase/upstream/.env.example` and `utils/generate-keys.sh`, `utils/add-new-auth-keys.sh` are absent from the vendored snapshot; the generator fails until they are fetched from the pinned upstream commit.
- `secrets_generate.py` does not create the `.env` (JWT_SECRET) that `add-new-auth-keys.sh` requires. Deploy copy was patched to write it in a tmpfs workdir (mode 0600, O_EXCL).
Proposed change: vendor the three files with checksums recorded in `UPSTREAM.lock`; add the `.env` step to the generator.
Backward compatible? yes.

### 8. Egress proxy bootstrap has a chicken-and-egg  (To: C1)
Problem: the registry role writes a Docker proxy drop-in to `http://10.77.0.11:3128`, but nothing starts a Squid there (the `egress_proxy` role only renders `squid.conf` for the app-stack Squid, which needs a Squid image digest from the missing release lock). Result: after the registry play, `docker pull` fails on a fresh host. The agent had to remove the drop-in temporarily to pull base images.
Proposed change: start an ops Squid (pinned image) in the ops stack before writing the drop-in, or write the drop-in only after Squid is healthy.
Backward compatible? yes.

### 9. Smaller
- `infra/ci/ops-note.sh` lacks the exec bit (`git update-index --chmod=+x`); `db-bootstrap.yml` fails on it.
- Registry and ops-nginx htpasswd passwords are generated and never stored; store them (sops) or print once to the operator.
- Docker builds used the legacy builder because buildx is not installed (`# syntax=` line ignored); install `docker-buildx-plugin` in the `docker_engine` role.
- Repo ships CRLF-sensitive shell scripts; with `core.autocrlf=true` on Windows, `git archive` produced CRLF and broke them on Linux. Add `.gitattributes` with `*.sh text eol=lf`, `*.j2 text eol=lf`.

Backward compatible? yes for all items.
Tenant/security impact: none new. Item 7 keeps JWT secret out of persistent disk (tmpfs only). Item 6 adds three DB passwords, to be stored sops-encrypted like the others. No PHI fields, no new public surface.
IRD/regulatory impact: none.
Alternatives considered: patching the deploy copy only (done for the first deploy; not repeatable, so not acceptable for the next host/DR rebuild).
Tests that will prove it:
- CI: image build of all six images (api, worker, web, renderer, pdf-sandbox, portal) plus postgres-pgbackrest from a clean checkout;
- CI: `next build` for web;
- Molecule/Ansible dry run on an empty host: baseline, secrets-generate, registry, monitoring, audit-store, supabase stack, with no manual steps and no `No such container`;
- shellcheck + exec-bit check on `infra/ci/*.sh`.
