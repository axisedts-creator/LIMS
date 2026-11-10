-- T0B-10.C6 schema suite: reporting catalogue properties (C6 05-SCHEMA §1, §3, §4, §6, §6.1-§6.3, §7; AC-0B-2.1, 2.2, 2.3, 2.4, 4.1, 4.2, 4.3, 5.1, 5.3, 6.2, 6.3).
-- Pure pg_catalog assertions: no fixtures, no data written. One rolled-back transaction. RLS is never disabled.
-- Run from the repo root: pg_prove -d <db> db/tests/reporting/T0B-10.C6_schema.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Markers (the node test checks them): C6 check 1 inventory/owner, 2 no sequences/enums/defaults, 3 tenant_id-leading indexes, 4 RLS ENABLE+FORCE, 5 policy set, 6 policy hygiene,
-- 7 grants / no DELETE / lookup role, 8 triggers + guard functions, 9 audit triggers + views, 10 FK direction + DEFINER catalogue + D-201 (no standing CREATE).
-- (checks 11-14 are in T0B-10.C6_behaviour.test.sql)
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE TEMP TABLE rt(t, cls, centre, upd, dele, npol) AS VALUES        -- cls: M C E A ; centre: centre-scoped ; upd/dele: lims_app UPDATE / DELETE granted ; npol: expected policies on the table
  ('settings','M',false,true,false,4),('staff_assignments','M',false,true,false,3),('centre_contacts','M',true,true,false,3),('referrer_preferences','M',false,true,false,3),
  ('channel_accounts','M',false,true,false,4),('message_template_texts','M',false,true,false,3),('report_templates','M',false,true,false,3),('report_template_versions','M',false,true,false,3),
  ('narrative_templates','M',false,true,false,3),('cs_reasons','M',false,true,false,3),
  ('reports','C',true,true,false,7),('report_order_items','C',true,true,false,3),('report_versions','C',true,true,false,8),('qr_tokens','C',true,true,false,7),('portal_links','C',true,true,false,8),
  ('deliveries','C',true,true,false,4),('input_files','C',true,true,false,3),('narrative_reports','C',true,true,false,3),('narrative_versions','C',true,true,false,3),
  ('otp_challenges','E',false,true,true,6),('portal_sessions','E',false,true,true,7),('print_jobs','E',true,true,true,4),('portal_payment_requests','E',false,true,true,5),
  ('delivery_attempts','A',false,false,false,2),('provider_events','A',false,true,false,5);
CREATE TEMP TABLE rg(t) AS VALUES ('g_message_templates'),('g_cs_reasons');
CREATE TEMP TABLE rv(v) AS VALUES ('v_pub_report_release'),('v_pub_order_report_tat'),('v_pub_delivery_daily');
CREATE TEMP TABLE rf(f) AS VALUES ('tg_report_versions_guard'),('tg_deliveries_scrub_only'),('tg_portal_links_guard'),('tg_narrative_versions_guard'),('tg_portal_payment_requests_guard');
CREATE TEMP TABLE rd(f, args) AS VALUES ('reporting_verify_qr','bytea'),('reporting_resolve_portal_credential','text, bytea'),('reporting_ingest_provider_callback','text, bytea, jsonb'),('reporting_redeem_link_for_app','bytea, bytea');

-- C6 check 1: inventory, owner (AC-0B-1.2), schema privileges
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'reporting'::regnamespace AND c.relkind IN ('r','p')), 25 + 2 + 1, 'C6 check 1: reporting holds 25 tenant + 2 G tables + event_inbox');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'reporting'::regnamespace AND c.relkind = 'v'), 3, 'C6 check 1: 3 v_pub_* views');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'reporting'::regnamespace AND c.relkind = 'm'), 0, 'no materialised view');
SELECT is(pg_get_userbyid(c.relowner), 'lims_owner', 'C6 check 1: reporting.' || c.relname || ' owned by lims_owner (AC-0B-1.2)') FROM pg_class c WHERE c.relnamespace = 'reporting'::regnamespace AND c.relkind IN ('r','v');
SELECT is(has_schema_privilege('lims_app', 'reporting', 'USAGE'), true, 'lims_app has USAGE on schema reporting');
SELECT is(has_schema_privilege(r, 'reporting', 'CREATE'), false, r || ' cannot CREATE in reporting') FROM unnest(ARRAY['lims_app','lims_api','lims_worker','lims_reporting_lookup']) r;
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'reporting'::regnamespace AND c.relkind = 'r' AND c.relname = x.t), 1, 'table reporting.' || x.t || ' exists') FROM (SELECT t FROM rt UNION ALL SELECT t FROM rg) x;

-- C6 check 2: no sequences / enums / defaults on id, tenant_id (04 D9)
SELECT is((SELECT count(*)::int FROM pg_class WHERE relkind = 'S' AND relnamespace = 'reporting'::regnamespace), 0, 'C6 check 2: no sequences in reporting');
SELECT is((SELECT count(*)::int FROM pg_type t WHERE t.typnamespace = 'reporting'::regnamespace AND t.typtype = 'e'), 0, 'C6 check 2: no ENUM types');
SELECT is((SELECT count(*)::int FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'reporting'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
            AND a.attname IN ('id','tenant_id') AND a.atthasdef), 0, 'C6 check 2: no DEFAULT on id / tenant_id');
SELECT is((SELECT count(*)::int FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'reporting'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
            AND a.attname ~ '^(token|otp_code|otp|password|access_token)$'), 0, 'C6 check 2: no plaintext credential column (hash / hmac only, 08 R24)');
SELECT is((SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = ('reporting.' || x.t)::regclass AND a.attname = x.c), 'bytea', 'C6 check 2: reporting.' || x.t || '.' || x.c || ' is bytea')
  FROM (VALUES ('qr_tokens','token_sha256'),('portal_links','token_sha256'),('portal_sessions','token_sha256'),('otp_challenges','code_hmac'),('channel_accounts','callback_token_sha256')) x(t, c);

-- C6 check 3: tenant_id leads every index / unique constraint of tenant tables except the four global token-hash indexes (CR-C6-002)
SELECT is((SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]), 'tenant_id', 'C6 check 3: ' || c.relname || ' index ' || ic.relname || ' leads with tenant_id')
  FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_class ic ON ic.oid = i.indexrelid
 WHERE c.relnamespace = 'reporting'::regnamespace AND c.relkind = 'r' AND c.relname NOT LIKE 'g\_%' AND c.relname <> 'event_inbox'
   AND ic.relname NOT IN ('qr_tokens__token_sha256__uq','portal_links__token_sha256__uq','portal_sessions__token_sha256__uq','channel_accounts__callback_token_sha256__p_uq')
   AND NOT (i.indisprimary AND i.indnatts = 1 AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]) = 'id');
SELECT is((SELECT count(*)::int FROM pg_index i WHERE i.indexrelid = ('reporting.' || x.n)::regclass AND i.indisunique), 1, 'C6 check 3: global token index reporting.' || x.n || ' is UNIQUE')
  FROM (VALUES ('qr_tokens__token_sha256__uq'),('portal_links__token_sha256__uq'),('portal_sessions__token_sha256__uq'),('channel_accounts__callback_token_sha256__p_uq')) x(n);
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'u' AND (SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.attnum) = ARRAY['tenant_id','id']), 'C6 check 3: reporting.' || c.relname || ' has UNIQUE (tenant_id, id)')
  FROM pg_class c JOIN pg_constraint p ON p.conrelid = c.oid AND p.contype = 'p' AND p.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = c.oid AND attname = 'id')]
 WHERE c.relnamespace = 'reporting'::regnamespace AND c.relkind = 'r' AND c.relname NOT LIKE 'g\_%' AND c.relname <> 'event_inbox';

-- C6 check 4: RLS (AC-0B-2.1)
SELECT is(c.relrowsecurity AND c.relforcerowsecurity, true, 'C6 check 4 / AC-0B-2.1: reporting.' || x.t || ' ENABLE + FORCE RLS') FROM rt x JOIN pg_class c ON c.relname = x.t AND c.relnamespace = 'reporting'::regnamespace;
SELECT is(c.relrowsecurity, false, 'C6 check 4 / AC-0B-2.1: reporting.' || x.t || ' (class G) is RLS-exempt') FROM rg x JOIN pg_class c ON c.relname = x.t AND c.relnamespace = 'reporting'::regnamespace;

-- C6 check 5: exact policy set (AC-0B-2.2 / 2.3); 107 = 41 spec literals + 66 template-derived
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'reporting' AND p.tablename = x.t), x.npol, 'C6 check 5 / AC-0B-2.2: reporting.' || x.t || ' has ' || x.npol || ' policies') FROM rt x;
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'reporting' AND p.tablename <> 'event_inbox'), 107, 'C6 check 5: exactly 107 reporting policies');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'reporting' AND p.tablename IN (SELECT t FROM rg)), 0, 'G tables carry no policy');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'reporting' AND p.tablename = 'delivery_attempts' AND p.cmd = 'UPDATE'), 0, 'C6 check 5: delivery_attempts has no UPDATE policy (class A)');
SELECT is((SELECT array_agg(DISTINCT p.tablename::text ORDER BY p.tablename::text) FROM pg_policies p WHERE p.schemaname = 'reporting' AND p.cmd = 'DELETE'),
  ARRAY['otp_challenges','portal_payment_requests','portal_sessions','print_jobs'], 'C6 check 5: DELETE policies only on the four E tables (purge_ephemeral)');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'reporting' AND p.cmd = 'DELETE' AND p.policyname !~ '__delete__tenant_expired$'), 0, 'C6 check 5: every DELETE policy is __tenant_expired');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'reporting' AND p.cmd = 'ALL'), 0, 'C6 check 5: no FOR ALL policy');
SELECT is((SELECT array_agg(p.policyname::text ORDER BY p.policyname::text) FROM pg_policies p WHERE p.schemaname = 'reporting' AND p.roles = ARRAY['lims_reporting_lookup']::name[]),
  ARRAY['channel_accounts__select__lookup','deliveries__select__owner_only','portal_links__select__lookup','portal_links__select__owner_only','portal_links__update__owner_only','portal_sessions__select__lookup',
        'provider_events__insert__lookup','provider_events__select__lookup','qr_tokens__select__lookup','report_versions__select__lookup','report_versions__select__owner_only','reports__select__owner_only'],
  'C6 check 5: exactly 12 policies TO lims_reporting_lookup (§6.2)');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'reporting' AND p.tablename <> 'event_inbox' AND p.roles = ARRAY['lims_app']::name[]), 95, 'C6 check 5: 95 policies TO lims_app');

-- C6 check 6: policy hygiene (AC-0B-2.2, A16.1, CR-C13-011, A17 P-16, A21.1/A21.4)
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'reporting' AND (p.roles && ARRAY['public','anon','authenticated']::name[])), 0, 'C6 check 6 / AC-0B-2.2: no policy for public / anon / authenticated');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'reporting' AND (p.qual = 'true' OR p.with_check = 'true')), 0, 'C6 check 6 / AC-0B-2.2: no USING (true) / WITH CHECK (true)');
SELECT ok(p.policyname ~ ('^' || p.tablename || '__(select|insert|update|delete)__(tenant|tenant_centre|portal|partner|patient|tenant_system|tenant_expired|lookup|owner_only)$'), 'C6 check 6: policy name shape ' || p.policyname)
  FROM pg_policies p WHERE p.schemaname = 'reporting' AND p.tablename <> 'event_inbox';
SELECT ok(coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'current_centre_ids\(\)( AS current_centre_ids)?\)::uuid\[\]', 'C6 check 6: A16.1 cast in ' || p.policyname)
  FROM pg_policies p WHERE p.schemaname = 'reporting' AND coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'current_centre_ids';
SELECT ok(coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'engagement_patient_ids\(\)( AS engagement_patient_ids)?\)::uuid\[\]', 'C6 check 6: A16.1 cast in ' || p.policyname)
  FROM pg_policies p WHERE p.schemaname = 'reporting' AND coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'engagement_patient_ids';
SELECT ok(coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'is_staff_or_system', 'C6 check 6: staff guard in ' || p.policyname || ' (08 A17 P-16 / review fix #34)')
  FROM pg_policies p WHERE p.schemaname = 'reporting' AND p.policyname ~ '__(tenant|tenant_centre)$';
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'reporting' AND p.tablename IN ('otp_challenges','portal_sessions','portal_payment_requests') AND p.policyname ~ '__(tenant|tenant_centre)$'), 0,
  'C6 check 6: staff have no policy on the credential / session / payment-request tables');
SELECT ok(coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'app\.pre_[a-z_0-9]+', 'C6 check 6: lookup policy ' || p.policyname || ' is bound to an app.pre_* GUC (A21.4)')
  FROM pg_policies p WHERE p.schemaname = 'reporting' AND p.roles = ARRAY['lims_reporting_lookup']::name[];
SELECT ok(p.qual ~ 'portal_link_purpose', 'C6 check 6: ' || p.policyname || ' requires claim portal_link_purpose (A21.1: dues links see no content)')
  FROM pg_policies p WHERE p.schemaname = 'reporting' AND p.policyname IN ('report_versions__select__portal','qr_tokens__select__portal');
-- AC-0B-2.3: db/policies/reporting.sql is the canonical copy (CI diff in node test + gate 9); here: the live catalogue has all 107
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'reporting' AND p.tablename <> 'event_inbox'), 107, 'AC-0B-2.3: the 107 policies of db/policies/reporting.sql are the live policies');

-- C6 check 7: grants (AC-0B-4.2 / 4.3), lookup role
SELECT is(has_table_privilege('lims_app', 'reporting.' || x.t, 'DELETE'), x.dele, 'C6 check 7 / AC-0B-4.2: lims_app DELETE on reporting.' || x.t || ' = ' || x.dele) FROM rt x;
SELECT is(has_table_privilege('lims_app', 'reporting.' || x.t, p), true, 'lims_app has ' || p || ' on reporting.' || x.t) FROM rt x CROSS JOIN unnest(ARRAY['SELECT','INSERT']) p;
SELECT is(has_table_privilege('lims_app', 'reporting.' || x.t, 'UPDATE'), x.upd, 'C6 check 7 / AC-0B-4.3: lims_app UPDATE on reporting.' || x.t || ' = ' || x.upd) FROM rt x;
SELECT is(has_table_privilege('lims_app', 'reporting.' || x.t, p), p = 'SELECT', 'lims_app ' || p || ' on G table reporting.' || x.t || ' = ' || (p = 'SELECT')) FROM rg x CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p;
SELECT is(has_table_privilege('lims_app', 'reporting.event_inbox', 'UPDATE'), false, 'AC-0B-4.3: lims_app has no UPDATE on reporting.event_inbox');
SELECT is(has_table_privilege('lims_app', c.oid, 'TRUNCATE') OR has_table_privilege('lims_app', c.oid, 'REFERENCES') OR has_table_privilege('lims_app', c.oid, 'TRIGGER'), false, 'lims_app has no TRUNCATE/REFERENCES/TRIGGER on reporting.' || c.relname)
  FROM pg_class c WHERE c.relnamespace = 'reporting'::regnamespace AND c.relkind = 'r';
SELECT is(has_table_privilege(r, c.oid, 'DELETE'), false, 'C6 check 7: ' || r || ' has no DELETE on reporting.' || c.relname) FROM pg_class c CROSS JOIN unnest(ARRAY['lims_reporting_lookup','anon','authenticated']) r
 WHERE c.relnamespace = 'reporting'::regnamespace AND c.relkind = 'r' AND c.relname <> 'event_inbox' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
SELECT is(has_table_privilege('lims_reporting_lookup', 'reporting.' || t, 'SELECT'), true, 'C6 check 7: lims_reporting_lookup can SELECT reporting.' || t)
  FROM unnest(ARRAY['qr_tokens','report_versions','portal_links','portal_sessions','channel_accounts','reports','deliveries','provider_events']) t;
SELECT is(has_table_privilege('lims_reporting_lookup', 'reporting.provider_events', 'INSERT'), true, 'C6 check 7: lookup role can INSERT provider_events (callback ingest)');
SELECT is(has_table_privilege('lims_reporting_lookup', 'reporting.' || x.t, 'INSERT') OR has_table_privilege('lims_reporting_lookup', 'reporting.' || x.t, 'UPDATE'), false, 'C6 check 7: lookup role has no whole-table write on reporting.' || x.t)
  FROM (SELECT t FROM rt WHERE t <> 'provider_events') x;
SELECT is(has_column_privilege('lims_reporting_lookup', 'reporting.portal_links', c, 'UPDATE'), c IN ('redeem_failures','updated_at','version'), 'C6 check 7: lookup role UPDATE on portal_links.' || c || ' only for the redeem counter (D-30)')
  FROM unnest(ARRAY['redeem_failures','updated_at','version','revoked_at','delivery_id','expires_at','token_sha256','use_count']) c;
SELECT is(has_table_privilege('lims_reporting_lookup', 'reporting.' || t, 'SELECT'), false, 'lookup role cannot read reporting.' || t) FROM unnest(ARRAY['settings','otp_challenges','portal_payment_requests','narrative_versions','input_files','delivery_attempts']) t;
SELECT is(has_table_privilege(r, 'reporting.' || v, p), (r IN ('lims_app','lims_analytics','lims_api') AND p = 'SELECT'), r || ' ' || p || ' on reporting.' || v || ' (AC-0B-4.3 / §7)')
  FROM rv CROSS JOIN unnest(ARRAY['lims_app','lims_analytics','lims_api','anon']) r CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);

-- C6 check 8: mutable-columns + guard triggers (AC-0B-4.1 catalogue half; behaviour in T0B-10.C6_behaviour)
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = ('reporting.' || x.t)::regclass AND t.tgname = x.t || '__mutable_columns' AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgfoid = 'app.enforce_mutable_columns'::regproc), 1,
  'C6 check 8: reporting.' || x.t || ' mutable_columns trigger enabled')
  FROM (VALUES ('reports'),('report_versions'),('qr_tokens'),('deliveries'),('portal_links'),('provider_events'),('input_files'),('portal_payment_requests'),('report_template_versions')) x(t);
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = ('reporting.' || x.t)::regclass AND t.tgname = x.n AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgfoid = ('reporting.' || x.f)::regproc AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16), 1,
  'C6 check 8: reporting.' || x.t || ' trigger ' || x.n || ' BEFORE UPDATE FOR EACH ROW')
  FROM (VALUES ('report_versions','report_versions__guard','tg_report_versions_guard'),('deliveries','deliveries__scrub_only','tg_deliveries_scrub_only'),('portal_links','portal_links__guard','tg_portal_links_guard'),
    ('narrative_versions','narrative_versions__guard','tg_narrative_versions_guard'),('portal_payment_requests','portal_payment_requests__guard','tg_portal_payment_requests_guard')) x(t, n, f);
SELECT is(pg_get_userbyid(p.proowner), 'lims_owner', 'C6 check 8: reporting.' || f || ' owned by lims_owner') FROM rf JOIN pg_proc p ON p.pronamespace = 'reporting'::regnamespace AND p.proname = rf.f;
SELECT ok(NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=""'], 'C6 check 8: reporting.' || f || ' is SECURITY INVOKER with search_path pinned') FROM rf JOIN pg_proc p ON p.pronamespace = 'reporting'::regnamespace AND p.proname = rf.f;
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'reporting'::regnamespace), 5, 'reporting has exactly the five guard functions');
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'reporting'::regnamespace AND p.prosecdef), 0, 'no SECURITY DEFINER function in reporting (the four DEFINERs live in app)');
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled <> 'O' AND t.tgrelid IN (SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'reporting'::regnamespace)), 0, 'no reporting trigger disabled');
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = 'reporting.report_template_versions'::regclass AND t.tgname = 'report_template_versions__mutable_columns' AND t.tgqual IS NOT NULL), 1, 'report_template_versions mutable_columns is conditional (WHEN OLD.status <> draft)');

-- C6 check 9: audit triggers (AC-0B-5.1, 5.3) and views
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = ('reporting.' || x.t)::regclass AND t.tgname = x.t || '__audit' AND t.tgenabled = 'O' AND t.tgfoid = 'app.tg_row_audit'::regproc), 1, 'C6 check 9 / AC-0B-5.1: reporting.' || x.t || ' audit trigger')
  FROM (VALUES ('settings'),('staff_assignments'),('centre_contacts'),('referrer_preferences'),('channel_accounts'),('message_template_texts'),('report_templates'),('report_template_versions'),('narrative_templates'),
    ('cs_reasons'),('reports'),('report_order_items'),('report_versions'),('qr_tokens'),('deliveries'),('input_files'),('narrative_reports'),('narrative_versions')) x(t);
SELECT is((SELECT array_agg(t.tgname::text ORDER BY t.tgname::text) FROM pg_trigger t WHERE t.tgrelid = 'reporting.portal_links'::regclass AND t.tgfoid = 'app.tg_row_audit'::regproc), ARRAY['portal_links__audit_ins','portal_links__audit_upd'],
  'C6 check 9: portal_links has the two conditional audit triggers (§1 note)');
SELECT ok((SELECT t.tgqual IS NOT NULL FROM pg_trigger t WHERE t.tgrelid = 'reporting.portal_links'::regclass AND t.tgname = 'portal_links__audit_upd'), 'portal_links__audit_upd has a WHEN clause (redeem counter updates not audited)');
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = ('reporting.' || x.t)::regclass AND t.tgfoid = 'app.tg_row_audit'::regproc), 0, 'C6 check 9: E / A / G reporting.' || x.t || ' has no audit trigger')
  FROM (SELECT t FROM rt WHERE cls IN ('E','A') UNION ALL SELECT t FROM rg) x;
SELECT is(has_table_privilege('lims_app', 'audit.audit_log', 'INSERT'), false, 'AC-0B-5.3: lims_app has no INSERT on audit.audit_log');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'reporting'::regnamespace AND c.relkind = 'v' AND c.relname = x.v), 1, 'C6 check 9: view reporting.' || x.v || ' exists') FROM rv x;
SELECT ok(coalesce(c.reloptions @> ARRAY['security_invoker=true'] OR c.reloptions @> ARRAY['security_invoker=on'], false), 'C6 check 9: reporting.' || x.v || ' has security_invoker = true') FROM rv x JOIN pg_class c ON c.relname = x.v AND c.relnamespace = 'reporting'::regnamespace;
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = 'reporting.v_pub_delivery_daily'::regclass AND a.attnum > 0 AND NOT a.attisdropped),
  ARRAY['tenant_id','business_date','channel','purpose','recipient_kind','queued','sent','delivered','read','failed','suppressed','centre_id'], 'C6 check 9: v_pub_delivery_daily columns = IC §6.4 (centre_id last, CR-C8-005)');
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = 'reporting.v_pub_report_release'::regclass AND a.attnum > 0 AND NOT a.attisdropped),
  ARRAY['tenant_id','report_id','version_no','order_id','centre_id','report_kind','released_at','release_basis','superseded_at'], 'C6 check 9: v_pub_report_release columns = IC §6.4');
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = 'reporting.v_pub_order_report_tat'::regclass AND a.attnum > 0 AND NOT a.attisdropped),
  ARRAY['tenant_id','order_id','centre_id','registered_at','first_released_at','final_released_at','total_tat_seconds'], 'C6 check 9: v_pub_order_report_tat columns = IC §6.4');

-- C6 check 10: FK direction / relocatability (AC-0B-6.2); DEFINER catalogue and D-201 window (AC-0B-6.3)
SELECT is((SELECT count(*)::int FROM pg_constraint k JOIN pg_class s ON s.oid = k.conrelid JOIN pg_class t ON t.oid = k.confrelid
            WHERE k.contype = 'f' AND s.relnamespace = 'reporting'::regnamespace AND t.relnamespace NOT IN ('reporting'::regnamespace, 'core'::regnamespace, 'catalog'::regnamespace, 'frontdesk'::regnamespace)), 0,
  'C6 check 10 / AC-0B-6.2: reporting FKs point only into reporting / core / catalog / frontdesk (never billing or lab)');
SELECT is((SELECT count(*)::int FROM pg_constraint k JOIN pg_class s ON s.oid = k.conrelid JOIN pg_class t ON t.oid = k.confrelid
            WHERE k.contype = 'f' AND t.relnamespace = 'reporting'::regnamespace AND s.relnamespace <> 'reporting'::regnamespace), 0, 'C6 check 10: no FK into reporting from another schema yet');
SELECT is((SELECT count(*)::int FROM pg_constraint k WHERE k.contype = 'f' AND k.conrelid IN (SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'reporting'::regnamespace) AND k.conname !~ '__fk$'), 0, 'all reporting FK names end __fk');
SELECT is((SELECT count(*)::int FROM pg_constraint k WHERE k.contype = 'f' AND k.conname IN ('deliveries__link__fk','report_templates__current_version__fk')), 2, 'circular FKs added after both tables exist');
SELECT is((SELECT count(*)::int FROM pg_constraint k WHERE k.contype = 'f' AND k.conrelid IN (SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'reporting'::regnamespace) AND array_length(k.conkey, 1) > 1
            AND k.conkey[1] <> (SELECT attnum FROM pg_attribute WHERE attrelid = k.conrelid AND attname = 'tenant_id')), 0, 'composite FKs lead with tenant_id (AC-0B-3.5)');
SELECT is((SELECT count(*)::int FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid JOIN pg_class v ON v.oid = r.ev_class
            WHERE v.relnamespace = 'reporting'::regnamespace AND v.relkind = 'v' AND d.refclassid = 'pg_class'::regclass AND (SELECT relnamespace FROM pg_class WHERE oid = d.refobjid) IN ('billing'::regnamespace, 'lab'::regnamespace)), 0,
  'no reporting view reads billing or lab');
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND p.proname = rd.f AND p.prosecdef), 1, 'C6 check 10: app.' || rd.f || ' is SECURITY DEFINER') FROM rd;
SELECT is(pg_get_userbyid(p.proowner), 'lims_reporting_lookup', 'C6 check 10: app.' || rd.f || ' owned by lims_reporting_lookup') FROM rd JOIN pg_proc p ON p.oid = ('app.' || rd.f || '(' || rd.args || ')')::regprocedure;
SELECT ok(p.proconfig @> ARRAY['search_path=""'], 'C6 check 10: app.' || rd.f || ' has search_path = ''''') FROM rd JOIN pg_proc p ON p.oid = ('app.' || rd.f || '(' || rd.args || ')')::regprocedure;
SELECT is(has_function_privilege(r, p.oid, 'EXECUTE'), r = 'lims_api', 'C6 check 10: EXECUTE on app.' || rd.f || ' for ' || r || ' = ' || (r = 'lims_api'))
  FROM rd JOIN pg_proc p ON p.oid = ('app.' || rd.f || '(' || rd.args || ')')::regprocedure CROSS JOIN unnest(ARRAY['lims_app','lims_api','lims_worker','anon','authenticated']) r WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
SELECT is(has_function_privilege('public', p.oid, 'EXECUTE'), false, 'C6 check 10: PUBLIC has no EXECUTE on app.' || rd.f) FROM rd JOIN pg_proc p ON p.oid = ('app.' || rd.f || '(' || rd.args || ')')::regprocedure;
SELECT is(has_schema_privilege('lims_reporting_lookup', 'app', 'CREATE'), false, 'C6 check 10 / AC-0B-6.3 (D-201): lims_reporting_lookup holds no standing CREATE on schema app');
SELECT is(has_database_privilege('lims_reporting_lookup', current_database(), 'CREATE'), false, 'C6 check 10 (D-201): lims_reporting_lookup holds no CREATE on the database');
SELECT is(has_function_privilege('lims_reporting_lookup', 'app.enqueue_job(text, jsonb, text, timestamptz, integer)', 'EXECUTE'), false, 'C6 check 10 / LD-49 (b) (C6-T29): lookup role may NOT call app.enqueue_job (the API handler enqueues under withTenantScope)');
SELECT is((SELECT rolbypassrls OR rolsuper OR rolcanlogin FROM pg_roles WHERE rolname = 'lims_reporting_lookup'), false, 'lims_reporting_lookup is NOLOGIN NOBYPASSRLS NOSUPERUSER');

SELECT * FROM finish();
ROLLBACK;
