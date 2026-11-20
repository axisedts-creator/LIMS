-- C16.T-SEC1 live-DB catalog probes for EVERY engagement table (07-SECURITY §6.2; 05-SCHEMA §1 grants, §5 RLS template, §5.2 matrix).
-- Asserts on the migrated catalog (no data needed): FORCE RLS on all tables, DELETE only where the spec grants it, a tenant-bound policy per granted command, no PUBLIC/anon access.
-- Behavioural per-actor SQL probes (tenant A claims x {user all-centres, user centre A1, system, patient A1, pre-auth, display A1} vs tenant B rows) are the per-task suites
-- db/tests/engagement/T-A3_pre_acc.test.sql, T-L2_redeem_link_code.test.sql, T-OPS1_purge.test.sql and the generated db/tests/isolation/*.test.sql; they need seeded rows per table and are not repeated here.
-- Synthetic data only; nothing is written. Run: pg_prove -d <migrated db with the engagement DDL of CR-C16-006> db/tests/engagement/T-SEC1_table_probes.test.sql   (superuser; pgTAP in schema `extensions`; repo root)
-- Needs a live Postgres with C0 + C16 migrations; it is NOT part of .orchestra/notes/T-SEC1-verify.cmd (no database in the unit-test environment).
-- Fails now: the migrated schema has no `engagement` tables (the DDL of 05-SCHEMA §3 is not in db/migrations yet), so the table-count assertion is the first failure.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE TEMP TABLE expected(tbl text PRIMARY KEY, grants text NOT NULL, is_global boolean NOT NULL);
INSERT INTO expected VALUES
 ('settings','SIU',false),('accounts','SIU',false),('otp_challenges','SIUD',false),('link_codes','SIUD',false),('link_consents','SI',false),('account_patient_links','SIU',false),
 ('self_registrations','SIU',false),('addresses','SIU',false),('bookable_items','SIU',false),('booking_centres','SIU',false),('slot_templates','SIU',false),('slot_blackouts','SIU',false),
 ('slot_occupancy','SIU',false),('bookings','SIU',false),('booking_items','SI',false),('booking_transitions','SI',false),('patient_orders','SIUD',false),('patient_order_specimens','SIUD',false),
 ('patient_reports','SIUD',false),('smart_summaries','SIUD',false),('notifications','SIUD',false),('payment_requests','SIU',false),('queue_definitions','SIU',false),('queue_counters','SIU',false),
 ('queue_day_counters','SIU',false),('queue_tokens','SIU',false),('queue_displays','SIU',false),('reminders','SIU',false),('membership_plans','SIU',false),('patient_memberships','SIU',false),
 ('number_counters','SIUD',false),('enquiries','SIU',false),('enquiry_messages','SI',false),('cs_booking_cancel_reasons','SIU',false),('cs_reminder_reasons','SIU',false),('cs_enquiry_categories','SIU',false),
 ('g_cs_booking_cancel_reasons','S',true),('g_cs_reminder_reasons','S',true),('g_cs_enquiry_categories','S',true),('event_inbox','SI',false),
 -- T0B-GREEN-3 (STALE): migration 20261117240000 (T0C-MSGDESK-1) added three staff-only tenant tables (S I U for lims_app, one policy per command, no DELETE)
 ('broadcast_template','SIU',false),('broadcast','SIU',false),('broadcast_recipient','SIU',false),
 -- T0B-GREEN-3 (STALE): migration 20261117130000_engagement__add_portal_content.sql (T0C-CONTENT-1, LD-313/LD-325) added two staff-write tenant tables (S I U for lims_app, no DELETE)
 ('portal_content','SIU',false),('profile_image','SIU',false);

SELECT is((SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'engagement' AND c.relkind IN ('r','p')), 45::bigint,
  'engagement schema holds exactly the 45 tables (40 of 05-SCHEMA §1 + 3 broadcast tables of T0C-MSGDESK-1 + portal_content and profile_image of migration 20261117130000)');
SELECT is((SELECT count(*) FROM expected), 45::bigint, 'the probe list has 45 rows');
SELECT is((SELECT array_agg(c.relname::text ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'engagement' AND c.relkind IN ('r','p')),
          (SELECT array_agg(tbl ORDER BY tbl) FROM expected), 'no table is missing or unexpected (every table is probed)');

-- RLS enabled AND forced on every table (owner lims_owner; policies TO lims_app)
-- T0B-GREEN-3 (HARNESS): the 3 G tables (global coded sets, no tenant_id) are RLS-exempt by design (AC-0B-2.1 / 2.4, db/tests/rls_exempt.txt; T0B-13.C16_schema check 2 asserts it): they carry SELECT only and no policy.
-- The assertion still names every other table; a second assertion pins that the G tables really are the exempt set, with no policy that would make an exempt table look protected.
SELECT is((SELECT array_agg(c.relname::text ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'engagement' AND c.relkind IN ('r','p') AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
             AND c.relname NOT IN (SELECT tbl FROM expected WHERE is_global)),
          NULL::text[], 'every engagement table has ENABLE + FORCE ROW LEVEL SECURITY (except the 3 RLS-exempt G tables)');
SELECT is((SELECT array_agg(c.relname::text ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'engagement' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity),
          (SELECT array_agg(tbl ORDER BY tbl) FROM expected WHERE is_global), 'the tables without RLS are exactly the 3 G tables (rls_exempt.txt)');
SELECT is((SELECT count(*)::int FROM pg_policies p JOIN expected e ON e.tbl = p.tablename WHERE p.schemaname = 'engagement' AND e.is_global), 0, 'the G tables carry no policy');
SELECT is((SELECT array_agg(c.relname::text ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'engagement' AND c.relkind IN ('r','p') AND pg_get_userbyid(c.relowner) <> 'lims_owner'),
          NULL::text[], 'every engagement table is owned by lims_owner');

-- grants: exactly the inventory letters for lims_app; DELETE only on the 8 class-E tables; nothing for PUBLIC / anon / authenticated
SELECT is((SELECT array_agg(e.tbl ORDER BY e.tbl) FROM expected e WHERE has_table_privilege('lims_app', 'engagement.' || e.tbl, 'DELETE') <> (position('D' IN e.grants) > 0)),
          NULL::text[], 'DELETE is granted to lims_app exactly on otp_challenges, link_codes, notifications, number_counters and the four read-model tables');
SELECT is((SELECT array_agg(e.tbl ORDER BY e.tbl) FROM expected e WHERE has_table_privilege('lims_app', 'engagement.' || e.tbl, 'SELECT') <> (position('S' IN e.grants) > 0)), NULL::text[], 'SELECT grants match 05-SCHEMA §1');
SELECT is((SELECT array_agg(e.tbl ORDER BY e.tbl) FROM expected e WHERE has_table_privilege('lims_app', 'engagement.' || e.tbl, 'INSERT') <> (position('I' IN e.grants) > 0)), NULL::text[], 'INSERT grants match 05-SCHEMA §1');
SELECT is((SELECT array_agg(e.tbl ORDER BY e.tbl) FROM expected e WHERE has_table_privilege('lims_app', 'engagement.' || e.tbl, 'UPDATE') <> (position('U' IN e.grants) > 0)), NULL::text[], 'UPDATE grants match 05-SCHEMA §1');
SELECT is((SELECT array_agg(e.tbl ORDER BY e.tbl) FROM expected e WHERE has_table_privilege('lims_app', 'engagement.' || e.tbl, 'TRUNCATE')), NULL::text[], 'TRUNCATE is granted on no engagement table');
SELECT is((SELECT array_agg(r.rolname::text || '.' || e.tbl) FROM expected e CROSS JOIN pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role', 'lims_monitor', 'lims_replicator')
           AND (has_table_privilege(r.rolname, 'engagement.' || e.tbl, 'SELECT') OR has_table_privilege(r.rolname, 'engagement.' || e.tbl, 'INSERT') OR has_table_privilege(r.rolname, 'engagement.' || e.tbl, 'UPDATE') OR has_table_privilege(r.rolname, 'engagement.' || e.tbl, 'DELETE'))),
          NULL::text[], 'no Supabase / monitoring role can read or write engagement tables directly');

-- policies: one per granted command for lims_app (owner_only policies are TO lims_owner and excluded); naming <table>__<cmd>__<scope>
SELECT is((SELECT array_agg(e.tbl || ':' || cmd.c ORDER BY e.tbl, cmd.c)
           FROM expected e JOIN LATERAL (VALUES ('S','SELECT'),('I','INSERT'),('U','UPDATE'),('D','DELETE')) AS cmd(l, c) ON position(cmd.l IN e.grants) > 0
           WHERE NOT e.is_global   -- T0B-GREEN-3 (HARNESS): the G tables are RLS-exempt (no policy by design, see above); their SELECT-only grant is pinned by the grant assertions
             AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'engagement' AND p.tablename = e.tbl AND 'lims_app' = ANY (p.roles) AND p.cmd IN (cmd.c, 'ALL'))),
          NULL::text[], 'every granted command has a policy TO lims_app (a grant without a policy would read as zero rows by accident, not by design)');
SELECT is((SELECT array_agg(p.tablename || '.' || p.policyname ORDER BY 1) FROM pg_policies p WHERE p.schemaname = 'engagement' AND p.cmd = 'ALL' AND 'lims_app' = ANY (p.roles)),
          NULL::text[], 'no FOR ALL policy to lims_app (policies are per command, 02-CV §5)');
SELECT is((SELECT array_agg(p.tablename || '.' || p.policyname ORDER BY 1) FROM pg_policies p WHERE p.schemaname = 'engagement' AND 'public' = ANY (p.roles)), NULL::text[], 'no policy TO PUBLIC');

-- tenant binding: SELECT/UPDATE/DELETE qual and INSERT/UPDATE check of every lims_app policy on a tenant table mention the tenant predicate (directly or through the tenant-bound helper)
-- LD-257 / migration 20261116030000: the 3 RESTRICTIVE number_counters policies are allowed here, tenant isolation stays with the existing PERMISSIVE tenant policy (a RESTRICTIVE policy can only narrow it)
SELECT is((SELECT array_agg(p.tablename || '.' || p.policyname ORDER BY 1)
           FROM pg_policies p JOIN expected e ON e.tbl = p.tablename
           WHERE p.schemaname = 'engagement' AND NOT e.is_global AND 'lims_app' = ANY (p.roles)
             AND p.policyname NOT IN ('number_counters__select__nonstaff_keys','number_counters__insert__nonstaff_keys','number_counters__update__nonstaff_keys')
             AND coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') !~ 'current_tenant_id|engagement_account_id|engagement_patient_ids|engagement_patient_visible|current_actor_id'),
          NULL::text[], 'every lims_app policy on a tenant table is tenant-bound (app.current_tenant_id() or a tenant-resolving DEFINER helper)');
SELECT is((SELECT array_agg(p.tablename || '.' || p.policyname ORDER BY 1)
           FROM pg_policies p JOIN expected e ON e.tbl = p.tablename
           WHERE p.schemaname = 'engagement' AND NOT e.is_global AND p.cmd = 'DELETE' AND 'lims_app' = ANY (p.roles) AND coalesce(p.qual, '') !~ 'is_system|current_actor_type|system'),
          NULL::text[], 'every DELETE policy admits only the system actor (05-SCHEMA §1)');

-- tenant_id column on every tenant table, absent on the global coded sets
SELECT is((SELECT array_agg(e.tbl ORDER BY e.tbl) FROM expected e WHERE NOT e.is_global AND NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'engagement' AND c.table_name = e.tbl AND c.column_name = 'tenant_id')),
          NULL::text[], 'every tenant table has a tenant_id column');
SELECT is((SELECT array_agg(e.tbl ORDER BY e.tbl) FROM expected e WHERE e.is_global AND EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'engagement' AND c.table_name = e.tbl AND c.column_name = 'tenant_id')),
          NULL::text[], 'global coded sets carry no tenant_id');

SELECT * FROM finish();
ROLLBACK;
