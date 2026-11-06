```
Title: CR-C0-<nnn>: SP-3 — fill the 05-SCHEMA §1 GRANT CONNECT placeholder for the Supabase service roles; LIMS dbname = image init DB
From chunk: C0 (SP-3)      To owner: C0-0B (05-SCHEMA §1, db/bootstrap/01_database.sql) · C0-0A (dev stack compose.yaml)
Type: schema
Blocking? no for SP-3 · T0B-01 needs it (else GoTrue/Storage/PostgREST lose CONNECT after REVOKE ALL … FROM PUBLIC)
Problem: SP-3 (db/meta/decisions/SP-3.md) on supabase/postgres:17.6.1.136: the image creates schemas extensions/auth/storage and
  its role grants only in its init database (`postgres`); a new CREATE DATABASE has none of them. LIMS needs them (auth.users,
  storage.objects policies, PostgREST api schema, extensions in `extensions`), so the LIMS database is the one the services use.
  REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC then removes CONNECT from supabase_auth_admin, supabase_storage_admin, authenticator
  (verified). Also: `postgres` is not a superuser in this image; the superuser is supabase_admin.
Proposed change (exact):
  1. 05-SCHEMA §1 01_database.sql: replace the 4-line "SP-3 (review C0 m#36)" comment with
     GRANT CONNECT ON DATABASE :"dbname" TO supabase_auth_admin, supabase_storage_admin, authenticator;  -- SP-3: same DB as LIMS
  2. 05-SCHEMA §1 header note: bootstrap runs as the image superuser supabase_admin, with dbname = the image init database (`postgres`).
  3. 02-TRD dev stack compose.yaml: auth, storage and rest point at the same dbname.
Backward compatible? yes (restores the CONNECT the image ships with, only for the three service login roles)
Tenant/security impact: no RLS change; no grant on schema app to supabase_auth_admin (08 R10); anon/authenticated/service_role get no CONNECT (NOLOGIN)
IRD/regulatory impact: n/a
Alternatives considered: separate database for LIMS (rejected: auth/storage/extensions schemas absent there; cross-DB refs impossible)
Tests that will prove it: db/tests/roles — has_database_privilege(r, current_database(), 'CONNECT') = t for the three roles and = f for PUBLIC
```
