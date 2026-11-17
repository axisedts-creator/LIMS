-- infra/tests/internal/roles.sql (07-SEC; 02-TRD s8.1). Read-only assertions on database roles.
-- Run: psql -X -v ON_ERROR_STOP=1 -d <app database> -f this file. Any failure = RAISE EXCEPTION = non-zero exit.
--  1. No role named lims_% has SUPERUSER or BYPASSRLS (rolsuper / rolbypassrls).
--  2. rolreplication only for lims_replicator and lims_audit_ship (CR-C1-002); no other non-superuser.
DO $$
DECLARE
  r record;
  repl text[] := ARRAY['lims_replicator', 'lims_audit_ship'];
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'lims\_%' AND (rolsuper OR rolbypassrls) LOOP
    RAISE EXCEPTION 'roles: % is SUPERUSER or BYPASSRLS', r.rolname;
  END LOOP;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolreplication AND NOT rolsuper AND rolname <> ALL (repl) LOOP
    RAISE EXCEPTION 'roles: % has REPLICATION (allowed only for %)', r.rolname, repl;
  END LOOP;
END $$;
