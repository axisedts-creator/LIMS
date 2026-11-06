-- db/bootstrap/01_database.sql — C0 05-SCHEMA §1. Run by the provisioning superuser after 00_roles.sql, connected to :dbname.
-- psql -v ON_ERROR_STOP=1 -v dbname=... -d <dbname> -f db/bootstrap/01_database.sql
-- 08 A25 D-201: no standing CREATE for lims_queue / lims_reporting_lookup. lims_owner holds CREATE WITH GRANT OPTION [CONV: so
-- the migration that creates lims_queue-owned objects can grant CREATE to lims_queue for that file only and revoke it again, §10
-- "queue wrapper"; lims_owner is NOLOGIN and reachable only through lims_migrator SET ROLE].
GRANT CREATE ON DATABASE :"dbname" TO lims_owner WITH GRANT OPTION;
GRANT CONNECT ON DATABASE :"dbname" TO lims_migrator, lims_api, lims_worker;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
-- Extensions that need superuser are created here, only if SP-3 confirms availability in supabase/postgres:17.6.1.136:
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;   -- REQ-ARCH-023 (C4 name search); schema 'extensions' as in the Supabase image
CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA extensions; -- 08 A31.1: tenant-leading trigram GIN indexes (C4, C11); availability stays an SP-3 check
GRANT USAGE ON SCHEMA extensions TO lims_owner, lims_migrator;   -- 08 A31.1: migrations reference opclasses schema-qualified (extensions.gin_trgm_ops)
-- The test-harness extension is NEVER created here; the harness creates it in CI/dev databases only (SP-3).
GRANT CONNECT ON DATABASE :"dbname" TO lims_monitor, lims_audit_ship;    -- CR-C1-002 (lims_replicator uses the replication protocol only)
-- SP-3 (review C0 m#36): record which database the Supabase services (GoTrue, Storage, PostgREST) connect to in the pinned image.
-- If it is this database, REVOKE ALL ... FROM PUBLIC above removes their CONNECT, and SP-3 adds
--   GRANT CONNECT ON DATABASE :"dbname" TO <the auth, storage and PostgREST login roles>;
-- with the exact role names recorded from supabase/postgres:17.6.1.136 (UNVERIFIED until SP-3; not guessed here).
