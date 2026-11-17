-- infra/tests/internal/auditstore_roles.sql (05-SCHEMA s3.5; AC-18.3). Read-only assertions on the audit-store database
-- (LD-45: "auditstore" in full, "lims_audit" in lean/dev). Run: psql -X -v ON_ERROR_STOP=1 -d <store db> -f this file.
-- Any failure = RAISE EXCEPTION = non-zero exit. The source-vs-store column comparison itself is drift.py (job
-- auditstore-drift); here the store side of the 08 A29.2 / A28.5 fixture is pinned.
DO $$
DECLARE
  r text; t text; p text; s text;
  people  text[] := ARRAY['audit_writer', 'audit_digest', 'audit_reader', 'lims_monitor'];
  tables  text[] := ARRAY['audit.audit_log', 'audit.access_log', 'billing.activity_log'];
  meta    text[] := ARRAY['auditstore_meta.daily_digests', 'auditstore_meta.ops_audit', 'auditstore_meta.schema_sync_log'];
BEGIN
  -- 1. append-only: nobody who is a person or a job may rewrite replicated rows or digests
  FOREACH r IN ARRAY people LOOP
    FOREACH t IN ARRAY tables || meta LOOP
      FOREACH p IN ARRAY ARRAY['UPDATE', 'DELETE', 'TRUNCATE'] LOOP
        IF has_table_privilege(r, t, p) THEN
          RAISE EXCEPTION 'AC-18.3: role % has % on %', r, p, t;
        END IF;
      END LOOP;
    END LOOP;
    -- 2. no membership path to the owner (SET ROLE auditstore_owner would give UPDATE/DELETE)
    IF pg_has_role(r, 'auditstore_owner', 'MEMBER') OR pg_has_role(r, 'auditstore_owner', 'USAGE') THEN
      RAISE EXCEPTION 'AC-18.3: role % can act as auditstore_owner', r;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r AND (rolsuper OR rolbypassrls)) THEN
      RAISE EXCEPTION 'AC-18.3: role % is SUPERUSER or BYPASSRLS', r;
    END IF;
  END LOOP;

  -- 2b. review T-15 item 5: under LD-45 lean the store shares the cluster with every app / Supabase role. EVERY non-superuser
  --     except the owner (lims_api, lims_worker, lims_migrator, lims_owner, authenticator, service_role ...) must lack
  --     UPDATE/DELETE/TRUNCATE on the store, and only the four store roles may CONNECT (the app cannot use the store).
  FOR r IN SELECT rolname FROM pg_roles WHERE NOT rolsuper AND rolname <> 'auditstore_owner' AND rolname !~ '^pg_' LOOP
    FOREACH t IN ARRAY tables || meta LOOP
      FOREACH p IN ARRAY ARRAY['UPDATE', 'DELETE', 'TRUNCATE'] LOOP
        IF has_table_privilege(r, t, p) THEN
          RAISE EXCEPTION 'AC-18.3: role % has % on %', r, p, t;
        END IF;
      END LOOP;
    END LOOP;
    IF has_database_privilege(r, current_database(), 'CONNECT') AND r <> ALL (people) THEN
      RAISE EXCEPTION 'LD-45: role % can CONNECT to the audit store database (only % may)', r, people;
    END IF;
  END LOOP;

  -- 3. the subscription owner inserts into every replicated table
  FOREACH t IN ARRAY tables LOOP
    IF NOT has_table_privilege('audit_writer', t, 'INSERT') THEN
      RAISE EXCEPTION 'AC-18.2: audit_writer lacks INSERT on %', t;
    END IF;
    IF has_table_privilege('audit_reader', t, 'SELECT') OR has_table_privilege('audit_reader', t, 'INSERT') THEN
      RAISE EXCEPTION 'audit_reader has a direct privilege on % (views only)', t;
    END IF;
  END LOOP;

  -- 4. audit_reader: views only, no privilege on the data schemas
  FOREACH s IN ARRAY ARRAY['audit', 'billing', 'auditstore_meta'] LOOP
    IF has_schema_privilege('audit_reader', s, 'USAGE') OR has_schema_privilege('audit_reader', s, 'CREATE') THEN
      RAISE EXCEPTION 'audit_reader has a privilege on schema %', s;
    END IF;
  END LOOP;
  IF NOT has_schema_privilege('audit_reader', 'auditstore', 'USAGE') THEN
    RAISE EXCEPTION 'audit_reader lacks USAGE on schema auditstore';
  END IF;

  -- 5. the digest job appends digests and can never rewrite them
  IF NOT (has_table_privilege('audit_digest', 'auditstore_meta.daily_digests', 'INSERT')
          AND has_table_privilege('audit_digest', 'auditstore_meta.daily_digests', 'SELECT')
          AND has_table_privilege('audit_digest', 'auditstore_meta.ops_audit', 'INSERT')) THEN
    RAISE EXCEPTION 'audit_digest lacks SELECT/INSERT on daily_digests or INSERT on ops_audit';
  END IF;
  FOREACH t IN ARRAY tables LOOP
    IF has_table_privilege('audit_digest', t, 'INSERT') THEN
      RAISE EXCEPTION 'audit_digest has INSERT on %', t;
    END IF;
  END LOOP;

  -- 6. nobody but the owner role is a member of auditstore_owner
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles o ON o.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
              WHERE o.rolname = 'auditstore_owner' AND NOT u.rolsuper) THEN
    RAISE EXCEPTION 'auditstore_owner has non-superuser members';
  END IF;

  -- 7. 08 A29.2 / A28.5 fixture (store side): detail present, actor_id and created_by nullable
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'audit' AND table_name = 'audit_log' AND column_name = 'detail'
                    AND data_type = 'jsonb' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION 'A29.2: audit.audit_log.detail jsonb (nullable) missing';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'audit' AND table_name = 'audit_log' AND column_name IN ('actor_id', 'created_by')
         AND is_nullable = 'YES') <> 2 THEN
    RAISE EXCEPTION 'A28.5: audit.audit_log.actor_id / created_by must be nullable';
  END IF;

  RAISE NOTICE 'auditstore role assertions: OK';
END
$$;
