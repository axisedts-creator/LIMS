-- T0B-10.C7 schema suite: instruments catalogue properties (C7 05-SCHEMA §1, §3, §4, §5, §6, §7; AC-0B-2.1, 2.2, 2.3, 2.4, 4.1, 4.2, 4.3, 5.1, 5.3, 6.2, 6.3).
-- Pure pg_catalog assertions: no fixtures, no data written. One rolled-back transaction. RLS is never disabled.
-- Run from the repo root: pg_prove -d <db> db/tests/instruments/T0B-10.C7_schema.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Markers (the node test checks them): C7 check 1 inventory/owner, 2 no sequences/enums/defaults + credential columns, 3 tenant_id-leading indexes, 4 RLS ENABLE+FORCE, 5 policy set, 6 policy hygiene,
-- 7 grants (column-level secret_sha256, no DELETE, A tables append-only), 8 triggers + transition functions, 9 audit triggers + views, 10 FK direction + DEFINER catalogue + EXECUTE privileges (spec §8 item 10).
-- (checks 11-18 are in T0B-10.C7_behaviour.test.sql)
-- Scope note (as T0B-10.C5/C6 rulings): event_inbox is C0's (T0B-05) and is excluded from every count; lims_api / lims_worker INHERIT lims_app (C0 05-SCHEMA:52-53), so "no DELETE / no UPDATE" is asserted for them too and
-- row restriction is by policy, not grant.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE TEMP TABLE rt(t, cls, centre, upd, npol) AS VALUES        -- cls: M C E A ; centre: centre-scoped ; upd: lims_app whole-table UPDATE granted ; npol: expected policies on the table
  ('settings','M',false,true,3),('agents','M',true,true,4),('agent_credentials','M',true,false,4),('agent_status','E',true,true,4),('agent_health_transitions','A',true,false,4),
  ('agent_config_versions','A',true,false,2),('agent_commands','E',true,true,5),('agent_log_bundles','E',true,false,4),('instruments','M',true,true,3),('instrument_status','E',true,true,3),
  ('messages','A',true,false,4),('processing_runs','A',true,false,4),('message_records','A',true,false,4),('message_duplicates','A',true,false,4),('message_rejections','A',true,false,4),
  ('attachments','C',true,true,5),('observed_codes','E',true,true,5);
CREATE TEMP TABLE rg(t) AS VALUES ('g_drivers'),('g_agent_releases'),('g_cs_revoke_reasons'),('g_cs_reprocess_reasons');
CREATE TEMP TABLE rv(v) AS VALUES ('v_pub_agent_status'),('v_pub_message_daily'),('v_pub_instrument_directory');
CREATE TEMP TABLE rf(f, t) AS VALUES ('tg_agent_transition','agents'),('tg_instrument_transition','instruments'),('tg_credential_transition','agent_credentials'),('tg_command_transition','agent_commands'),('tg_attachment_transition','attachments');
CREATE TEMP TABLE rd(f, args, ex) AS VALUES ('instruments_resolve_device_credential','bytea','lims_api'),('instruments_agent_state_snapshot','','lims_worker'),('purge_instruments_archive','integer','lims_worker');

-- C7 check 1: inventory, owner (AC-0B-1.2), schema privileges
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'instruments'::regnamespace AND c.relkind IN ('r','p')), 17 + 4 + 1, 'C7 check 1: instruments holds 17 tenant + 4 G tables + event_inbox');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'instruments'::regnamespace AND c.relkind = 'v'), 3, 'C7 check 1: 3 v_pub_* views');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'instruments'::regnamespace AND c.relkind = 'm'), 0, 'no materialised view');
SELECT is(pg_get_userbyid(c.relowner), 'lims_owner', 'C7 check 1: instruments.' || c.relname || ' owned by lims_owner (AC-0B-1.2)') FROM pg_class c WHERE c.relnamespace = 'instruments'::regnamespace AND c.relkind IN ('r','v');
SELECT is(has_schema_privilege('lims_app', 'instruments', 'USAGE'), true, 'lims_app has USAGE on schema instruments');
SELECT is(has_schema_privilege(r, 'instruments', 'CREATE'), false, r || ' cannot CREATE in instruments') FROM unnest(ARRAY['lims_app','lims_api','lims_worker','lims_analytics']) r;
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'instruments'::regnamespace AND c.relkind = 'r' AND c.relname = x.t), 1, 'table instruments.' || x.t || ' exists') FROM (SELECT t FROM rt UNION ALL SELECT t FROM rg) x;

-- C7 check 2: no sequences / enums / defaults on id, tenant_id (04 D9); credential material is a 32-byte hash only
SELECT is((SELECT count(*)::int FROM pg_class WHERE relkind = 'S' AND relnamespace = 'instruments'::regnamespace), 0, 'C7 check 2: no sequences in instruments');
SELECT is((SELECT count(*)::int FROM pg_type t WHERE t.typnamespace = 'instruments'::regnamespace AND t.typtype = 'e'), 0, 'C7 check 2: no ENUM types');
SELECT is((SELECT count(*)::int FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'instruments'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
            AND a.attname IN ('id','tenant_id') AND a.atthasdef), 0, 'C7 check 2: no DEFAULT on id / tenant_id');
SELECT is((SELECT array_agg(c.relname || '.' || a.attname ORDER BY c.relname) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'instruments'::regnamespace AND c.relkind = 'r'
            AND a.attnum > 0 AND NOT a.attisdropped AND a.attname ~ '(secret|token|password|otp)'), ARRAY['agent_credentials.secret_sha256'], 'C7 check 2: the only credential column is agent_credentials.secret_sha256');
SELECT is((SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = 'instruments.agent_credentials'::regclass AND a.attname = 'secret_sha256'), 'bytea', 'C7 check 2: secret_sha256 is bytea');
SELECT is((SELECT count(*)::int FROM pg_constraint k WHERE k.conrelid = 'instruments.agent_credentials'::regclass AND k.contype = 'c' AND pg_get_constraintdef(k.oid) ~ 'octet_length\(secret_sha256\) = 32'), 1, 'C7 check 2: secret_sha256 is CHECKed to 32 bytes');

-- C7 check 3: tenant_id leads every index / unique constraint of tenant tables except the one global credential-hash index (stated reason, C0 §9 rule 2)
SELECT is((SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]), 'tenant_id', 'C7 check 3: ' || c.relname || ' index ' || ic.relname || ' leads with tenant_id')
  FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_class ic ON ic.oid = i.indexrelid
 WHERE c.relnamespace = 'instruments'::regnamespace AND c.relkind = 'r' AND c.relname NOT LIKE 'g\_%' AND c.relname <> 'event_inbox'
   AND ic.relname <> 'agent_credentials__secret_sha256__uq'
   AND NOT (i.indisprimary AND i.indnatts = 1 AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]) = 'id');
SELECT is((SELECT count(*)::int FROM pg_index i WHERE i.indexrelid = 'instruments.agent_credentials__secret_sha256__uq'::regclass AND i.indisunique AND i.indnatts = 1), 1, 'C7 check 3: global credential index is UNIQUE on (secret_sha256)');
SELECT is((SELECT count(*)::int FROM pg_index i WHERE i.indexrelid = ('instruments.' || n)::regclass AND i.indisunique), 1, 'C7 check 3: instruments.' || n || ' is UNIQUE')
  FROM unnest(ARRAY['agents__tenant_id_agent_code__uq','instruments__tenant_id_instrument_code__uq','messages__tenant_id_agent_id_agent_message_id__uq','messages__tenant_id_instrument_id_message_key__uq',
                    'processing_runs__tenant_id_message_id_run_no__uq','agent_config_versions__tenant_id_agent_id_config_version__uq']) n;
SELECT is((SELECT count(*)::int FROM pg_index i WHERE i.indexrelid = ('instruments.' || n)::regclass AND i.indpred IS NOT NULL), 1, 'C7 check 3: instruments.' || n || ' is a partial index')
  FROM unnest(ARRAY['agent_credentials__active_code__p_idx','agent_commands__expiry__p_idx','message_records__tenant_id_sample_barcode__p_idx','message_records__tenant_id_result_key_sha256__p_idx',
                    'message_records__tenant_id_source_record_id__p_idx','attachments__tenant_id_scan_state__p_idx']) n;

-- C7 check 4: RLS (AC-0B-2.1)
SELECT is(c.relrowsecurity AND c.relforcerowsecurity, true, 'C7 check 4 / AC-0B-2.1: instruments.' || x.t || ' ENABLE + FORCE RLS') FROM rt x JOIN pg_class c ON c.relname = x.t AND c.relnamespace = 'instruments'::regnamespace;
SELECT is(c.relrowsecurity, false, 'C7 check 4 / AC-0B-2.1: instruments.' || x.t || ' (class G) is RLS-exempt') FROM rg x JOIN pg_class c ON c.relname = x.t AND c.relnamespace = 'instruments'::regnamespace;

-- C7 check 5: exact policy set (AC-0B-2.2 / 2.3); 66 = 40 centre-template + 3 settings + 3 resolver/snapshot owner_only + 20 purge owner_only
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'instruments' AND p.tablename = x.t), x.npol, 'C7 check 5 / AC-0B-2.2: instruments.' || x.t || ' has ' || x.npol || ' policies') FROM rt x;
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'instruments' AND p.tablename <> 'event_inbox'), 66, 'C7 check 5: exactly 66 instruments policies');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'instruments' AND p.tablename IN (SELECT t FROM rg)), 0, 'G tables carry no policy');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'instruments' AND p.tablename <> 'event_inbox' AND p.roles = ARRAY['lims_app']::name[]), 43, 'C7 check 5: 43 policies TO lims_app (40 template + 3 settings)');
SELECT is((SELECT array_agg(p.policyname::text ORDER BY p.policyname::text) FROM pg_policies p WHERE p.schemaname = 'instruments' AND p.tablename <> 'event_inbox' AND p.roles = ARRAY['lims_owner']::name[] AND p.cmd = 'SELECT' AND p.tablename IN ('agent_credentials','agents','agent_status')),
  ARRAY['agent_credentials__select__owner_only','agent_status__select__owner_only','agents__select__owner_only'], 'C7 check 5: resolver / snapshot owner_only SELECT policies');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'instruments' AND p.tablename <> 'event_inbox' AND p.roles = ARRAY['lims_owner']::name[]), 23, 'C7 check 5: 23 policies TO lims_owner only');
SELECT is((SELECT array_agg(DISTINCT p.tablename::text ORDER BY p.tablename::text) FROM pg_policies p WHERE p.schemaname = 'instruments' AND p.cmd = 'DELETE'),
  ARRAY['agent_commands','agent_health_transitions','agent_log_bundles','attachments','message_duplicates','message_records','message_rejections','messages','observed_codes','processing_runs'],
  'C7 check 5: DELETE policies exactly on the 10 purge tables');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'instruments' AND p.cmd = 'DELETE' AND NOT (p.roles = ARRAY['lims_owner']::name[] AND p.policyname ~ '__delete__owner_only$')), 0, 'C7 check 5: every DELETE policy is __delete__owner_only TO lims_owner (no lims_app DELETE policy)');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'instruments' AND p.cmd = 'ALL'), 0, 'C7 check 5: no FOR ALL policy');
SELECT is((SELECT array_agg(DISTINCT p.tablename::text ORDER BY p.tablename::text) FROM pg_policies p WHERE p.schemaname = 'instruments' AND p.cmd = 'UPDATE'),
  ARRAY['agent_commands','agent_credentials','agent_status','agents','attachments','instrument_status','instruments','observed_codes','settings'], 'C7 check 5: UPDATE policies only on the 8 §5 tables + settings');

-- C7 check 6: policy hygiene (AC-0B-2.2, A16.1, 08 A10.5 / A12.1 / A12.2 / A12.7, review #15)
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'instruments' AND (p.roles && ARRAY['public','anon','authenticated']::name[])), 0, 'C7 check 6 / AC-0B-2.2: no policy for public / anon / authenticated');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'instruments' AND (p.qual = 'true' OR p.with_check = 'true')), 0, 'C7 check 6 / AC-0B-2.2: no USING (true) / WITH CHECK (true)');
SELECT ok(p.policyname ~ ('^' || p.tablename || '__(select|insert|update|delete)__(tenant|tenant_centre|owner_only)$'), 'C7 check 6: policy name shape ' || p.policyname)
  FROM pg_policies p WHERE p.schemaname = 'instruments' AND p.tablename <> 'event_inbox';
SELECT ok(coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'current_centre_ids\(\)( AS current_centre_ids)?\)::uuid\[\]', 'C7 check 6: A16.1 cast in ' || p.policyname)
  FROM pg_policies p WHERE p.schemaname = 'instruments' AND coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'current_centre_ids';
SELECT ok(coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'is_staff_or_system', 'C7 check 6: staff guard in ' || p.policyname || ' (review #15)') FROM pg_policies p WHERE p.schemaname = 'instruments' AND p.policyname ~ '^settings__';
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'instruments' AND p.tablename <> 'settings' AND coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'is_staff_or_system'), 0,
  'C7 check 6: device actors write the centre tables, so no staff guard on them (§1.1)');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'instruments' AND p.tablename IN ('settings') AND coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'centre'), 0, 'C7 check 6: settings is tenant-only');
SELECT ok(p.qual ~ 'app\.maintenance' AND p.qual ~ 'purge_instruments_archive' AND p.qual ~ 'current_tenant_id', 'C7 check 6: purge owner policy ' || p.policyname || ' is bound to app.maintenance AND the claim tenant (one tenant per call, A13 P-6)')
  FROM pg_policies p WHERE p.schemaname = 'instruments' AND p.roles = ARRAY['lims_owner']::name[] AND p.tablename IN (SELECT t FROM rt) AND p.tablename NOT IN ('agent_credentials','agents','agent_status');
SELECT ok(p.qual ~ 'app\.pre_device_secret_sha256', 'C7 check 6: agent_credentials owner policy is bound to app.pre_device_secret_sha256 (A12.1)') FROM pg_policies p WHERE p.schemaname = 'instruments' AND p.policyname = 'agent_credentials__select__owner_only';
SELECT ok(p.qual ~ 'app\.pre_device_agent_id' AND p.qual ~ 'instruments_agent_state_snapshot', 'C7 check 6: agents owner policy serves resolver + snapshot') FROM pg_policies p WHERE p.schemaname = 'instruments' AND p.policyname = 'agents__select__owner_only';
-- AC-0B-2.3: db/policies/instruments.sql is the canonical copy (CI diff in node test + gate 9); here: the live catalogue has all 66
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'instruments' AND p.tablename <> 'event_inbox'), 66, 'AC-0B-2.3: the 66 policies of db/policies/instruments.sql are the live policies');

-- C7 check 7: grants (AC-0B-4.2 / 4.3; spec §8 item 4; CR-C7-006 column grant)
SELECT is(has_table_privilege(r, 'instruments.' || x.t, 'DELETE'), false, 'C7 check 7 / AC-0B-4.2: ' || r || ' has no DELETE on instruments.' || x.t) FROM rt x CROSS JOIN unnest(ARRAY['lims_app','lims_api','lims_worker','lims_analytics']) r;
SELECT is(has_table_privilege('lims_app', 'instruments.' || x.t, p), true, 'lims_app has ' || p || ' on instruments.' || x.t) FROM rt x CROSS JOIN unnest(ARRAY['SELECT','INSERT']) p WHERE x.t <> 'agent_credentials';
SELECT is(has_table_privilege('lims_app', 'instruments.' || x.t, 'UPDATE'), x.upd, 'C7 check 7 / AC-0B-4.3: lims_app UPDATE on instruments.' || x.t || ' = ' || x.upd) FROM rt x WHERE x.t <> 'agent_credentials';
SELECT is(has_table_privilege('lims_app', 'instruments.' || x.t, 'UPDATE'), false, 'C7 check 7 / AC-0B-4.3: class A instruments.' || x.t || ' has no UPDATE for lims_app') FROM rt x WHERE x.cls = 'A';
SELECT is(has_table_privilege('lims_app', 'instruments.' || x.t, p), p = 'SELECT', 'lims_app ' || p || ' on G table instruments.' || x.t || ' = ' || (p = 'SELECT')) FROM rg x CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p;
SELECT is(has_table_privilege('lims_app', 'instruments.event_inbox', 'UPDATE'), false, 'AC-0B-4.3: lims_app has no UPDATE on instruments.event_inbox');
SELECT is(has_table_privilege('lims_app', c.oid, 'TRUNCATE') OR has_table_privilege('lims_app', c.oid, 'REFERENCES') OR has_table_privilege('lims_app', c.oid, 'TRIGGER'), false, 'lims_app has no TRUNCATE/REFERENCES/TRIGGER on instruments.' || c.relname)
  FROM pg_class c WHERE c.relnamespace = 'instruments'::regnamespace AND c.relkind = 'r';
SELECT is(has_table_privilege(r, 'instruments.agent_credentials', p), false, 'C7 check 7: ' || r || ' has no whole-table ' || p || ' on agent_credentials (it would include secret_sha256)')
  FROM unnest(ARRAY['lims_app','lims_api','lims_worker','lims_analytics']) r CROSS JOIN unnest(ARRAY['SELECT','UPDATE','DELETE']) p;
SELECT is(has_column_privilege(r, 'instruments.agent_credentials', 'secret_sha256', p), false, 'C7 check 7 / spec §8 item 4: ' || r || ' cannot ' || p || ' agent_credentials.secret_sha256')
  FROM unnest(ARRAY['lims_app','lims_api','lims_worker','lims_analytics']) r CROSS JOIN unnest(ARRAY['SELECT','UPDATE']) p;
SELECT is(has_column_privilege('lims_app', 'instruments.agent_credentials', a.attname, 'SELECT'), a.attname <> 'secret_sha256', 'C7 check 7: lims_app column SELECT on agent_credentials.' || a.attname || ' (all but secret_sha256)')
  FROM pg_attribute a WHERE a.attrelid = 'instruments.agent_credentials'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
SELECT is(has_column_privilege('lims_app', 'instruments.agent_credentials', a.attname, 'INSERT'), true, 'C7 check 7: lims_app can INSERT agent_credentials.' || a.attname || ' (all columns)')
  FROM pg_attribute a WHERE a.attrelid = 'instruments.agent_credentials'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
SELECT is(has_column_privilege('lims_app', 'instruments.agent_credentials', c, 'UPDATE'),
  c IN ('status','used_at','last_used_at','revoked_at','revoked_by','revoke_reason_code','replaced_by_credential_id','updated_at','updated_by','version'),
  'C7 check 7: lims_app UPDATE on agent_credentials.' || c || ' only for lifecycle columns')
  FROM unnest(ARRAY['status','used_at','last_used_at','revoked_at','revoked_by','revoke_reason_code','replaced_by_credential_id','updated_at','updated_by','version','kind','secret_sha256','agent_id','expires_at','issued_at','issued_by','tenant_id','centre_id']) c;
SELECT is(has_table_privilege(r, 'instruments.' || v, p), (r IN ('lims_app','lims_analytics','lims_api','lims_worker') AND p = 'SELECT'), r || ' ' || p || ' on instruments.' || v || ' (AC-0B-4.3 / §6; lims_api, lims_worker inherit lims_app)')
  FROM rv CROSS JOIN unnest(ARRAY['lims_app','lims_analytics','lims_api','lims_worker','anon']) r CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);

-- C7 check 8: mutable-columns + transition triggers and functions (AC-0B-4.1 catalogue half; behaviour in T0B-10.C7_behaviour)
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = ('instruments.' || x.t)::regclass AND t.tgname = x.t || '__mutable_columns' AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgfoid = 'app.enforce_mutable_columns'::regproc
            AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16), 1, 'C7 check 8: instruments.' || x.t || ' mutable_columns trigger enabled, BEFORE UPDATE')
  FROM (VALUES ('agents'),('agent_credentials'),('agent_commands'),('instruments'),('attachments')) x(t);
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = ('instruments.' || rf.t)::regclass AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgfoid = ('instruments.' || rf.f)::regproc AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16), 1,
  'C7 check 8: instruments.' || rf.t || ' runs instruments.' || rf.f || ' BEFORE UPDATE FOR EACH ROW') FROM rf;
SELECT is(pg_get_userbyid(p.proowner), 'lims_owner', 'C7 check 8: instruments.' || f || ' owned by lims_owner') FROM rf JOIN pg_proc p ON p.pronamespace = 'instruments'::regnamespace AND p.proname = rf.f;
SELECT ok(NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=""'], 'C7 check 8: instruments.' || f || ' is SECURITY INVOKER with search_path pinned') FROM rf JOIN pg_proc p ON p.pronamespace = 'instruments'::regnamespace AND p.proname = rf.f;
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'instruments'::regnamespace), 5, 'instruments has exactly the five transition functions');
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'instruments'::regnamespace AND p.prosecdef), 0, 'no SECURITY DEFINER function in instruments (the three DEFINERs live in app)');
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled <> 'O' AND t.tgrelid IN (SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'instruments'::regnamespace)), 0, 'no instruments trigger disabled');
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN (SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'instruments'::regnamespace AND c.relkind = 'r')
            AND t.tgfoid <> 'app.tg_row_audit'::regproc), 10, 'C7 check 8: 5 mutable_columns + 5 transition triggers and nothing else (besides audit)');
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attname::text) FROM pg_trigger t, pg_attribute a
            WHERE t.tgrelid = 'instruments.agents'::regclass AND t.tgname = 'agents__mutable_columns' AND a.attrelid = t.tgrelid AND a.attnum > 0 AND NOT a.attisdropped AND a.attname NOT IN (SELECT unnest(string_to_array(encode(t.tgargs, 'escape'), E'\\000')))),
  ARRAY['agent_code','centre_id','created_at','created_by','id','tenant_id'], 'C7 check 8: agents mutable list = complement of {id, tenant_id, centre_id, agent_code, created_*} (§4)');
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attname::text) FROM pg_trigger t, pg_attribute a
            WHERE t.tgrelid = 'instruments.instruments'::regclass AND t.tgname = 'instruments__mutable_columns' AND a.attrelid = t.tgrelid AND a.attnum > 0 AND NOT a.attisdropped AND a.attname NOT IN (SELECT unnest(string_to_array(encode(t.tgargs, 'escape'), E'\\000')))),
  ARRAY['agent_id','centre_id','created_at','created_by','id','instrument_code','protocol','tenant_id'], 'C7 check 8: instruments mutable list = complement of {id, tenant_id, centre_id, agent_id, instrument_code, protocol, created_*} (§4)');

-- C7 check 9: audit triggers (AC-0B-5.1, 5.3) and views
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = ('instruments.' || x.t)::regclass AND t.tgname = x.t || '__audit' AND t.tgenabled = 'O' AND t.tgfoid = 'app.tg_row_audit'::regproc), 1, 'C7 check 9 / AC-0B-5.1: instruments.' || x.t || ' audit trigger')
  FROM (VALUES ('settings'),('agents'),('agent_credentials'),('agent_commands'),('instruments'),('attachments')) x(t);
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = ('instruments.' || x.t)::regclass AND t.tgfoid = 'app.tg_row_audit'::regproc), 0, 'C7 check 9: E / A / G instruments.' || x.t || ' has no audit trigger')
  FROM (SELECT t FROM rt WHERE t NOT IN ('settings','agents','agent_credentials','agent_commands','instruments','attachments') UNION ALL SELECT t FROM rg) x;
SELECT ok((SELECT encode(t.tgargs, 'escape') ~ 'secret_sha256' FROM pg_trigger t WHERE t.tgrelid = 'instruments.agent_credentials'::regclass AND t.tgname = 'agent_credentials__audit'), 'C7 check 9 / AC-0B-5.1: agent_credentials audit trigger excludes secret_sha256');
SELECT is(has_table_privilege('lims_app', 'audit.audit_log', 'INSERT'), false, 'AC-0B-5.3: lims_app has no INSERT on audit.audit_log');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'instruments'::regnamespace AND c.relkind = 'v' AND c.relname = x.v), 1, 'C7 check 9: view instruments.' || x.v || ' exists') FROM rv x;
SELECT ok(coalesce(c.reloptions @> ARRAY['security_invoker=true'] OR c.reloptions @> ARRAY['security_invoker=on'], false), 'C7 check 9: instruments.' || x.v || ' has security_invoker = true') FROM rv x JOIN pg_class c ON c.relname = x.v AND c.relnamespace = 'instruments'::regnamespace;
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = 'instruments.v_pub_agent_status'::regclass AND a.attnum > 0 AND NOT a.attisdropped),
  ARRAY['tenant_id','agent_id','centre_id','state','last_heartbeat_at','agent_version','queue_depth','clock_offset_seconds'], 'C7 check 9: v_pub_agent_status columns = IC §6.5');
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = 'instruments.v_pub_message_daily'::regclass AND a.attnum > 0 AND NOT a.attisdropped),
  ARRAY['tenant_id','instrument_id','centre_id','business_date','messages','patient_records','qc_records','unmatched','quarantined','duplicates'], 'C7 check 9: v_pub_message_daily columns = IC §6.5');
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = 'instruments.v_pub_instrument_directory'::regclass AND a.attnum > 0 AND NOT a.attisdropped),
  ARRAY['tenant_id','instrument_id','centre_id','instrument_code','display_name','vendor','model','state','is_active'], 'C7 check 9: v_pub_instrument_directory columns = IC §6.5');

-- C7 check 10: FK direction / relocatability (AC-0B-6.2); DEFINER catalogue, EXECUTE privileges (spec §8 item 10), seeds
SELECT is((SELECT count(*)::int FROM pg_constraint k JOIN pg_class s ON s.oid = k.conrelid JOIN pg_class t ON t.oid = k.confrelid
            WHERE k.contype = 'f' AND s.relnamespace = 'instruments'::regnamespace AND t.relnamespace NOT IN ('instruments'::regnamespace, 'core'::regnamespace)), 0,
  'C7 check 10 / AC-0B-6.2: instruments FKs point only into instruments / core (never lab, catalog, reporting)');
SELECT is((SELECT count(*)::int FROM pg_constraint k JOIN pg_class s ON s.oid = k.conrelid JOIN pg_class t ON t.oid = k.confrelid
            WHERE k.contype = 'f' AND t.relnamespace = 'instruments'::regnamespace AND s.relnamespace <> 'instruments'::regnamespace), 0, 'C7 check 10: no FK into instruments from another schema');
SELECT is((SELECT count(*)::int FROM pg_constraint k WHERE k.contype = 'f' AND k.conrelid IN (SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'instruments'::regnamespace) AND k.conname !~ '__fk$'), 0, 'all instruments FK names end __fk');
SELECT is((SELECT count(*)::int FROM pg_constraint k WHERE k.contype = 'f' AND k.conrelid IN (SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'instruments'::regnamespace) AND array_length(k.conkey, 1) > 1
            AND k.conkey[1] <> (SELECT attnum FROM pg_attribute WHERE attrelid = k.conrelid AND attname = 'tenant_id')), 0, 'composite FKs lead with tenant_id (AC-0B-3.5)');
SELECT is((SELECT count(*)::int FROM pg_constraint k WHERE k.conrelid = ('instruments.' || x.t)::regclass AND k.contype = 'f' AND pg_get_constraintdef(k.oid) ~ '\(tenant_id, [a-z_]+, centre_id\) REFERENCES instruments\.'), x.n,
  'C7 check 10 (review #26): instruments.' || x.t || ' has ' || x.n || ' centre-bound composite FK(s)')
  FROM (VALUES ('processing_runs',1),('message_records',2),('message_duplicates',1),('attachments',2),('messages',2),('instruments',1),('agent_credentials',1)) x(t, n);
SELECT is((SELECT count(*)::int FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid JOIN pg_class v ON v.oid = r.ev_class
            WHERE v.relnamespace = 'instruments'::regnamespace AND v.relkind = 'v' AND d.refclassid = 'pg_class'::regclass AND (SELECT relnamespace FROM pg_class WHERE oid = d.refobjid) NOT IN ('instruments'::regnamespace)), 0, 'no instruments view reads another schema');
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND p.proname = rd.f AND p.prosecdef), 1, 'C7 check 10: app.' || rd.f || ' is SECURITY DEFINER') FROM rd;
SELECT is(pg_get_userbyid(p.proowner), 'lims_owner', 'C7 check 10: app.' || rd.f || ' owned by lims_owner') FROM rd JOIN pg_proc p ON p.oid = ('app.' || rd.f || '(' || rd.args || ')')::regprocedure;
SELECT ok(p.proconfig @> ARRAY['search_path=""'] AND p.provolatile = 'v', 'C7 check 10: app.' || rd.f || ' has search_path = '''' and is VOLATILE (it calls set_config)') FROM rd JOIN pg_proc p ON p.oid = ('app.' || rd.f || '(' || rd.args || ')')::regprocedure;
SELECT is(has_function_privilege(r, p.oid, 'EXECUTE'), r = rd.ex, 'C7 check 10 / spec §8 item 10: EXECUTE on app.' || rd.f || ' for ' || r || ' = ' || (r = rd.ex))
  FROM rd JOIN pg_proc p ON p.oid = ('app.' || rd.f || '(' || rd.args || ')')::regprocedure CROSS JOIN unnest(ARRAY['lims_app','lims_api','lims_worker','anon','authenticated']) r WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
SELECT is(has_function_privilege('public', p.oid, 'EXECUTE'), false, 'C7 check 10: PUBLIC has no EXECUTE on app.' || rd.f) FROM rd JOIN pg_proc p ON p.oid = ('app.' || rd.f || '(' || rd.args || ')')::regprocedure;
SELECT is(has_schema_privilege('lims_owner', 'app', 'CREATE') AND NOT has_schema_privilege('lims_app', 'app', 'CREATE'), true, 'C7 check 10 / AC-0B-6.3: no standing CREATE on app for lims_app');
SELECT is((SELECT count(*)::int FROM instruments.g_cs_revoke_reasons), 6, 'C7 check 10: 6 revoke reasons seeded');
SELECT is((SELECT count(*)::int FROM instruments.g_cs_reprocess_reasons), 7, 'C7 check 10: 7 reprocess reasons seeded');
SELECT is((SELECT array_agg(code::text ORDER BY code::text) FROM instruments.g_drivers), ARRAY['astm_generic_e1394','file_drop_generic','getein_metis','hl7v2_generic_oru','mindray_bc5380_sketch','mindray_bs200_sketch','truth_h80e'], 'C7 check 10: 7 drivers seeded (5 + truth_h80e H80-T05 / LD-139 + getein_metis MET-T04 / LD-163)');
SELECT is((SELECT count(*)::int FROM instruments.g_drivers WHERE status = 'verified' OR cap_calibration OR cap_worklist_download), 0, 'C7 check 10: no verified driver / calibration / worklist capability seeded (B2)');
SELECT is((SELECT count(*)::int FROM instruments.g_drivers WHERE code LIKE '%sketch' AND status = 'sketch_blocked'), 2, 'C7 check 10: both Mindray sketches are sketch_blocked');

SELECT * FROM finish();
ROLLBACK;
