# SP-3 — pgTAP + extensions in supabase/postgres:17.6.1.136

- Date run: 2026-11-06 · Plan row: `spec/chunks/C0-foundation-contracts/06-IMPLEMENTATION-PLAN.md` SP-3 · CV §5.12, 05-SCHEMA §1, 08 A31.1, review C0 m#36
- Image: `supabase/postgres:17.6.1.136` (`sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00`), PostgreSQL 17.6
- **Outcome: pass.** pgTAP 1.3.3, pg_trgm 1.6 and btree_gin 1.3 are available in the pinned tag. One new constraint: the image's own schemas (`extensions`, `auth`, `storage`) exist only in its init database, so LIMS must use that database (see "Database"). CR `.orchestra/cr/SP-3.nonblocking.md` fills the 05-SCHEMA §1 placeholder.

## Decision

| Item | Value |
|---|---|
| Harness | Harness: **pgtap** (1.3.3). `db/tests` uses pgTAP in test/CI/dev databases only. pgtap is never created by bootstrap or prod migrations (05-SCHEMA §1 `01_database.sql` comment stays). |
| pg_trgm | available, 1.6. Bootstrap (`db/bootstrap/01_database.sql`) creates it `WITH SCHEMA extensions` as written in 05-SCHEMA §1 (REQ-ARCH-023). No CR to C4. |
| btree_gin | available, 1.3. Created `WITH SCHEMA extensions` in bootstrap. Hand-off to C11 / C4 (08 A31.1): tenant-leading index `USING gin (tenant_id, name extensions.gin_trgm_ops)` builds on the image. No index exception needed. |
| pgcrypto | available, 1.3, pre-installed by the image in schema `extensions`. |
| pg_uuidv7 | **not available** in the image (no row). No change: 05-SCHEMA uses the SQL function `app.uuidv7()` for trigger-side ids (04 D9); app code uses `@lims/shared-ts/uuidv7`. |
| Image superuser | `supabase_admin` (`rolsuper = t`). `postgres` is **not** a superuser in this image (`rolsuper = f`, `rolbypassrls = t`). Bootstrap files that need superuser run as `supabase_admin`. |
| Database | GoTrue, Storage and PostgREST connect to the same database as LIMS (the LIMS database). Reason: the image creates `extensions`, `auth`, `storage` and grants for its roles only in its init database (`postgres`); a new `CREATE DATABASE` has none of them (verified: 0 rows). LIMS needs them in its own database: `core.users` refers to GoTrue `auth.users`, 05-SCHEMA adds policies on `storage.objects`, PostgREST serves the `api` schema, and bootstrap creates extensions in `extensions`. So `:"dbname"` = the image's init database. |
| Login roles (verbatim from image) | GoTrue: `supabase_auth_admin` · Storage: `supabase_storage_admin` · PostgREST: `authenticator` (member of `anon`, `authenticated`, `service_role`; `rolinherit = f`). All three `rolcanlogin = t`, `rolsuper = f`. |
| GRANT CONNECT | Needed. `REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC` removes CONNECT from all three (verified `has_database_privilege(..., 'CONNECT') = f`). Add to `01_database.sql` right after that REVOKE: `GRANT CONNECT ON DATABASE :"dbname" TO supabase_auth_admin, supabase_storage_admin, authenticator;` (verified `= t` after). `anon` / `authenticated` / `service_role` are NOLOGIN, reached by `SET ROLE` from `authenticator`, so they need no CONNECT. No other grant to these roles; nothing on schema `app`. |

## Evidence

Throwaway container, bound to 127.0.0.1, removed afterwards. All statements run as the image superuser `supabase_admin`. Scratch databases `sp3_scratch` (pgTAP, extensions) and `sp3_lims` (grants). No LIMS data, synthetic only.

```sh
docker pull supabase/postgres:17.6.1.136
docker run -d --name sp3_pg -p 127.0.0.1:55433:5432 -e POSTGRES_PASSWORD=<scratch> supabase/postgres:17.6.1.136
psql -U supabase_admin -d postgres -c "SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name IN ('pgtap','pg_trgm','btree_gin','pgcrypto','pg_uuidv7') ORDER BY name;"
psql -U supabase_admin -d postgres -c "CREATE DATABASE sp3_scratch;" -c "CREATE DATABASE sp3_lims;"
psql -U supabase_admin -d sp3_scratch -c "CREATE EXTENSION pgtap;" -c "SELECT plan(2), ok(true,'sp3 smoke'), is(1,1,'sp3 is');"
psql -U supabase_admin -d sp3_scratch -c "CREATE SCHEMA IF NOT EXISTS extensions;" \
  -c "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;" -c "CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA extensions;" \
  -c "CREATE TABLE t(tenant_id uuid, name text); CREATE INDEX ON t USING gin (tenant_id, name extensions.gin_trgm_ops);"
psql -U supabase_admin -d sp3_lims -c "SELECT count(*) FROM pg_namespace WHERE nspname IN ('extensions','auth','storage');"
psql -U supabase_admin -d postgres -c "REVOKE ALL ON DATABASE postgres FROM PUBLIC;"   # then has_database_privilege x3
psql -U supabase_admin -d postgres -c "GRANT CONNECT ON DATABASE postgres TO supabase_auth_admin, supabase_storage_admin, authenticator;"
docker rm -f sp3_pg
```

Output (trimmed):

```text
current_user supabase_admin | PostgreSQL 17.6 on x86_64-pc-linux-gnu, compiled by gcc (GCC) 15.2.0, 64-bit

   name    | default_version | installed_version
-----------+-----------------+-------------------
 btree_gin | 1.3             |
 pg_trgm   | 1.6             |
 pgcrypto  | 1.3             | 1.3
 pgtap     | 1.3.3           |
(4 rows)            -- pg_uuidv7: no row (not available)

pre-installed (postgres db): pg_stat_statements 1.11, pgcrypto 1.3, uuid-ossp 1.1 in extensions; supabase_vault 0.3.1 in vault
CREATE EXTENSION pgtap -> pgtap 1.3.3 in public ; plan 1..2 | ok 1 - sp3 smoke | ok 2 - sp3 is
pg_trgm 1.6 / btree_gin 1.3 in extensions ; CREATE INDEX (gin tenant_id, name gin_trgm_ops) ok ; similarity('ram','rama') = 0.5
SET ROLE postgres; CREATE EXTENSION pgtap -> CREATE EXTENSION (allowed through supautils)
roles: supabase_admin super t login t | postgres super f login t bypassrls t
       supabase_auth_admin login t inherit f | supabase_storage_admin login t inherit f | authenticator login t inherit f
rolconfig: supabase_auth_admin search_path=auth ; supabase_storage_admin search_path=storage ; authenticator statement_timeout=8s
databases: postgres, template0, template1
schema owners (postgres db): auth supabase_admin, storage supabase_admin, extensions postgres
datacl postgres (as shipped): =Tc/postgres, ... (PUBLIC has CONNECT)
new database sp3_lims: extensions/auth/storage schemas = 0
after REVOKE ALL FROM PUBLIC: supabase_auth_admin=f supabase_storage_admin=f authenticator=f
after GRANT CONNECT:          supabase_auth_admin=t supabase_storage_admin=t authenticator=t
```

## Open points

- Services were not started; the connect target is inferred from the image layout and 05-SCHEMA (storage/auth objects in the LIMS database), not read from their env vars. The dev stack `compose.yaml` (0A, from C1 `UPSTREAM.lock`) must point GoTrue, Storage and PostgREST at `:"dbname"`; check in SP-5 / T0A-09 with a real login per role.
- Whether the image's `POSTGRES_DB` env renames the init database (and its init schemas follow) was not tested. Until then LIMS `dbname` = `postgres`.
- pgTAP lands in `public` by default. The harness should `CREATE EXTENSION pgtap WITH SCHEMA extensions` (or a test-only schema) so the `public` REVOKE in bootstrap is not affected; decide in T0B-08.
