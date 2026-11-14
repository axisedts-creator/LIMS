# T0D-DEP-01 answers (from code and spec only; LD-173 rule 4: not proven = UNKNOWN)

## 1. API access JWTs
- Source: GoTrue access tokens. The verifier is "GoTrue access-token verification", local key file only, never jku/jwk/x5u/kid (services/api/src/core/auth/jwt.ts:1, services/api/src/core/auth/jwt.ts:84). It is built at boot from config, so a missing or bad key file fails boot (services/api/src/core/bootstrap.ts:52-54, services/api/src/core/auth/jwt.ts:36).
- All four keys or none (services/api/src/core/config.ts:77, services/api/src/core/config.ts:82-91). With none, no bearerJwt operation can be mounted and bootstrap fails (services/api/src/core/config.ts:21-22).
- `LIMS_CORE_JWT_ALG`: one of HS256 | ES256 | RS256 (services/api/src/core/auth/jwt.ts:6); the token header `alg` must equal it exactly (services/api/src/core/auth/jwt.ts:83). SP-1 measured ES256 on GoTrue v2.197.0 with `GOTRUE_JWT_KEYS` (EC P-256); with only `GOTRUE_JWT_SECRET` GoTrue issues HS256 (db/meta/decisions/SP-1.md:12, db/meta/decisions/SP-1.md:20).
- `LIMS_CORE_JWT_ISSUER`: exact `iss` (services/api/src/core/auth/jwt.ts:89). SP-1 local dev value `http://127.0.0.1:54321/auth/v1`, per env = GoTrue `API_EXTERNAL_URL` (db/meta/decisions/SP-1.md:13).
- `LIMS_CORE_JWT_AUDIENCE`: must equal `aud` or be in the `aud` array (services/api/src/core/auth/jwt.ts:90-91). SP-1: `authenticated` (db/meta/decisions/SP-1.md:14).
- `LIMS_CORE_JWT_KEY_FILE`: path to a file. HS256 = the shared secret (one trailing newline stripped); ES256 = EC P-256 public key; RS256 = RSA public key (services/api/src/core/auth/jwt.ts:35-48).
- Claims read: `sub`, `session_id`, `aal`, `exp`, `iat` only (services/api/src/core/auth/jwt.ts:92-99, db/meta/decisions/SP-1.md:19).
- What a hosted Supabase project supplies for these four values: UNKNOWN (no spec file states it).

## 2. Storage (API and worker)
- Names: `LIMS_CORE_STORAGE_URL` = Storage API base incl. `/storage/v1`, no default; `LIMS_CORE_STORAGE_KEY_FILE` = path to the service credential file (db/provisioning/README.md:10-11).
- Buckets (11, all private; `reporting-legacy` never created): db/provisioning/create-storage-buckets.mjs:12-24, ensured idempotently by that script (db/provisioning/README.md:7-8).
- Boot with Storage unset: the API boots; ctx.storage / ctx.uploads / ctx.download are not wired and answer 503 `common.dependency_unavailable` (services/api/src/core/pipeline/boot.ts:30-33, services/api/src/core/pipeline/boot.ts:135). `createStorage` throws `common.internal` when `LIMS_CORE_STORAGE_KEY_FILE` is unset or unreadable (services/api/src/core/storage/index.ts:72-76), but boot does not call it. The API never reads `LIMS_CORE_STORAGE_URL` today.
- Worker: storage port is `notWired`; a job touching it fails (dead-letters); boot is unaffected (services/worker/src/core/bootstrap.ts:73-77).
- Bucket script with either name missing: exits 1 with "... is not set" (db/provisioning/create-storage-buckets.mjs:44, db/provisioning/create-storage-buckets.mjs:93).
- Storage HTTP client shape for the API: UNKNOWN (not pinned; services/api/src/core/storage/index.ts:38).

## 3. Ports
- API: fixed 0.0.0.0:8080 (services/api/src/main.ts:6); image EXPOSE 8080. Metrics/health: `LIMS_CORE_METRICS_PORT`, default 9464 (services/api/src/core/config.ts:127).
- Worker: no public port; metrics/health on `LIMS_CORE_METRICS_PORT` default 9464 (services/worker/src/main.ts:10).
- Web: 3000, chosen in apps/web/Dockerfile:43-45 [CONV] (`next start -p 3000`).

## 4. Migrations and db/bootstrap on a fresh database
- Order (dev): db/bootstrap as the image superuser, then migrations as lims_migrator, then db/seeds, seedAuthUsers, registry-sync (tools/devstack/up.ts:1-3).
- db/bootstrap: `00_roles.sql` then `01_database.sql` via psql with password psql variables from the secret store, once per cluster (db/bootstrap/00_roles.sql:2-5, tools/devstack/up.ts:58-70); dev glue also creates schema `migrations_meta` (tools/devstack/up.ts:66-68).
- Migrations: Atlas `migrate apply --dir file:///migrations --revisions-schema migrations_meta` as lims_migrator (tools/devstack/compose.yaml:179-188).
- Staging/production: "C1 runbook step" (db/bootstrap/00_roles.sql:2); the runbook itself: UNKNOWN. Storage buckets after bootstrap + migrations (db/provisioning/README.md:17-19).

## 5. First platform admin
- `pnpm --filter @lims/api identity:bootstrap-platform-admin --email <ops email> [--display-name <name>]` (services/api/src/modules/identity/cli/bootstrap-platform-admin.ts:2, services/api/package.json:9).
- Creates or reuses the GoTrue user, then one call to `app.identity_bootstrap_platform_admin`, which refuses with `bootstrap_closed` once an active superadmin exists (services/api/src/modules/identity/cli/bootstrap-platform-admin.ts:41-46, services/api/src/modules/identity/cli/bootstrap-platform-admin.ts:59-60). No password: forgot-password then TOTP at first login (services/api/src/modules/identity/cli/bootstrap-platform-admin.ts:55-56).
- Needs libpq `PG*` env for the DB (services/api/src/modules/identity/cli/bootstrap-platform-admin.ts:67-72) and `LIMS_IDENTITY_GOTRUE_URL`, `LIMS_IDENTITY_GOTRUE_SERVICE_KEY` (services/api/src/modules/identity/gotrue/gateway.http.ts:48). It imports `pg`, a devDependency (services/api/package.json:23), so it does NOT run in the production-only API image: run it from a dev checkout. Which DB role it must connect as: UNKNOWN.
