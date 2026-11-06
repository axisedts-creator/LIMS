-- T0B-01 role + database grant assertions (pgTAP; 05-SCHEMA §1, §10 schema test 30; AC-0B-1.1, AC-0B-1.2; 08 A25 D-201).
-- Run on a bootstrapped + migrated test DB as superuser:  pg_prove -d <db> db/tests/roles/00_bootstrap_roles.test.sql
-- (harness: pgTAP in test DBs only, SP-3). pgTAP lives in schema `extensions`.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

-- AC-0B-1.1: no lims_% role is superuser or BYPASSRLS
SELECT is_empty($$SELECT rolname FROM pg_roles WHERE rolname LIKE 'lims\_%' AND (rolbypassrls OR rolsuper)$$,
  'AC-0B-1.1 no lims_% role has rolsuper or rolbypassrls');

-- exact role set (no role outside the table; lims_migration is not created)
SELECT results_eq($$SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'lims\_%' ORDER BY 1$$,
  $$VALUES ('lims_analytics'),('lims_api'),('lims_app'),('lims_audit_ship'),('lims_migrator'),('lims_monitor'),
           ('lims_owner'),('lims_queue'),('lims_replicator'),('lims_reporting_lookup'),('lims_worker')$$,
  'exactly the 11 spec roles exist; lims_migration not created');

-- AC-0B-1.2: lims_owner NOLOGIN, plus the other NOLOGIN roles
SELECT is(rolcanlogin, false, r || ' rolcanlogin = false')
  FROM pg_roles, unnest(ARRAY['lims_owner','lims_app','lims_queue','lims_reporting_lookup','lims_analytics']) r WHERE rolname = r;
SELECT is(rolcanlogin, true, r || ' rolcanlogin = true')
  FROM pg_roles, unnest(ARRAY['lims_migrator','lims_api','lims_worker','lims_monitor','lims_replicator','lims_audit_ship']) r WHERE rolname = r;

-- every lims_% role: no createdb / createrole / bypassrls / super (4 flags x 11 roles)
SELECT is_empty($$SELECT rolname FROM pg_roles WHERE rolname LIKE 'lims\_%' AND (rolcreatedb OR rolcreaterole)$$,
  'no lims_% role has CREATEDB or CREATEROLE');

-- replication only for lims_replicator and lims_audit_ship
SELECT results_eq($$SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'lims\_%' AND rolreplication ORDER BY 1$$,
  $$VALUES ('lims_audit_ship'),('lims_replicator')$$, 'rolreplication only lims_replicator + lims_audit_ship');

-- membership with INHERIT / SET options (PG16+ pg_auth_members)
CREATE TEMP TABLE m AS
SELECT g.rolname::text AS grp, u.rolname::text AS member, a.inherit_option AS inh, a.set_option AS setopt
  FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles u ON u.oid = a.member
 WHERE u.rolname LIKE 'lims\_%';
SELECT results_eq($$SELECT grp, member, inh, setopt FROM m ORDER BY 1,2$$,
  $$VALUES ('lims_app','lims_api',true,false),('lims_app','lims_worker',true,false),
           ('lims_owner','lims_migrator',false,true),('lims_queue','lims_migrator',false,true),
           ('lims_queue','lims_worker',true,false),('lims_reporting_lookup','lims_migrator',false,true)$$,
  'lims_% memberships and INHERIT/SET options match 05-SCHEMA §1 exactly');
SELECT is(pg_has_role('lims_monitor','pg_monitor','MEMBER'), true, 'lims_monitor is member of pg_monitor');

-- privilege-escalation: api/worker cannot SET ROLE to owner / queue(api) / reporting_lookup; api is not in queue/owner/lookup
SELECT is(pg_has_role(u, r, 'MEMBER'), false, u || ' is not a member of ' || r)
  FROM unnest(ARRAY['lims_api']) u, unnest(ARRAY['lims_owner','lims_queue','lims_reporting_lookup']) r;
SELECT is(pg_has_role(u, r, 'USAGE'), false, u || ' has no inherited ' || r)
  FROM unnest(ARRAY['lims_api','lims_worker']) u, unnest(ARRAY['lims_owner','lims_reporting_lookup']) r;
SELECT is(pg_has_role('lims_worker','lims_queue','SET'), false, 'lims_worker cannot SET ROLE lims_queue');
SELECT is(pg_has_role('lims_api','lims_app','SET'), false, 'lims_api cannot SET ROLE lims_app');

-- role defaults (ALTER ROLE ... SET)
SELECT is((SELECT array_to_string(rolconfig, ',') FROM pg_roles WHERE rolname='lims_api'),
  'idle_in_transaction_session_timeout=30s,search_path=""', 'lims_api session guards') ;
SELECT is((SELECT array_to_string(rolconfig, ',') FROM pg_roles WHERE rolname='lims_worker'),
  'idle_in_transaction_session_timeout=120s,search_path=""', 'lims_worker session guards');

-- 01_database.sql: CREATE on DB to lims_owner WITH GRANT OPTION only; schema test 30 no standing CREATE
SELECT is(has_database_privilege('lims_owner', current_database(), 'CREATE'), true, 'lims_owner has CREATE on database');
SELECT is(has_database_privilege('lims_owner', current_database(), 'CREATE WITH GRANT OPTION'), true, 'lims_owner CREATE is WITH GRANT OPTION');
SELECT is_empty($$SELECT r.rolname FROM pg_roles r
   WHERE r.rolname NOT IN ('lims_owner') AND NOT r.rolsuper AND r.rolname !~ '^(pg_|supabase|authenticator|anon|authenticated|service_role|dashboard|pgbouncer|postgres)'
     AND has_database_privilege(r.oid, current_database(), 'CREATE')$$,
  'CREATE on database held by lims_owner only (among non-superuser, non-Supabase roles)');
SELECT is(has_database_privilege(r, current_database(), 'CREATE'), false, r || ' has no database CREATE (D-201)')
  FROM unnest(ARRAY['lims_worker','lims_api','lims_queue','lims_reporting_lookup','lims_app','lims_migrator','lims_monitor','lims_analytics']) r;
SELECT is(has_schema_privilege(r, 'app', 'CREATE'), false, r || ' has no CREATE on schema app (D-201)')
  FROM unnest(ARRAY['lims_worker','lims_api','lims_queue','lims_reporting_lookup']) r;
SELECT is(has_schema_privilege('public', 'public', 'CREATE'), false, 'PUBLIC has no CREATE on schema public');
SELECT is_empty($$SELECT (aclexplode(datacl)).privilege_type FROM pg_database
   WHERE datname = current_database() AND (aclexplode(datacl)).grantee = 0$$, 'ALL on database revoked from PUBLIC');

-- CONNECT grants
SELECT is(has_database_privilege(r, current_database(), 'CONNECT'), true, r || ' can CONNECT')
  FROM unnest(ARRAY['lims_migrator','lims_api','lims_worker','lims_monitor','lims_audit_ship']) r;
SELECT is(has_database_privilege('lims_app', current_database(), 'CONNECT'), false, 'group role lims_app has no CONNECT');

-- extensions schema usage (08 A31.1)
SELECT is(has_schema_privilege(r, 'extensions', 'USAGE'), true, r || ' has USAGE on schema extensions')
  FROM unnest(ARRAY['lims_owner','lims_migrator']) r;
-- pgtap never created by bootstrap: harness-only; bootstrap must not have put it in public
SELECT is_empty($$SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pgtap' AND n.nspname = 'public'$$,
  'pgtap not installed in public');

-- AC-0B-1.2: every table in every module schema is owned by lims_owner (vacuous before migrations; T0B-02+ fills it)
SELECT is_empty($$SELECT n.nspname||'.'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r','p') AND n.nspname NOT LIKE 'pg\_%' AND n.nspname NOT IN ('information_schema','public','extensions','auth','storage','realtime','_realtime','graphql','graphql_public','vault','pgsodium','pgsodium_masks','net','supabase_functions','graphile_worker','migrations_meta')
     AND pg_get_userbyid(c.relowner) <> 'lims_owner'$$, 'AC-0B-1.2 all module-schema tables owned by lims_owner');

SELECT * FROM finish();ROLLBACK;
