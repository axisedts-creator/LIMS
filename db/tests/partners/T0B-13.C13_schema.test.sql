-- T0B-13.C13 schema suite: partners catalogue properties (C13 05-SCHEMA §1, §4, §5, §6, §8, §9; AC-0B-2.1, 2.2, 2.3, 2.4, 3.6, 4.1, 4.2, 4.3, 5.1, 5.3, 6.1, 6.2, 6.3).
-- Pure pg_catalog assertions: no fixtures, no data written. One rolled-back transaction. RLS is never disabled.
-- Run from the repo root: pg_prove -d <db> db/tests/partners/T0B-13.C13_schema.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Markers (the node test checks them): C13 check 1 partners/owner/no sequences, enums or views, 2 RLS ENABLE+FORCE (G exempt), 3 policy set per table + owner policies + the 3 DELETE policies, 4 grant matrix (DELETE on 3 tables),
-- 5 indexes + constraint names, 6 triggers + functions (2 DEFINER) + audit, 7 FK direction + seeds + registry (AC-0B-6.1 / 6.2 / 6.3). Checks 8-14 are in T0B-13.C13_behaviour.test.sql.
-- Scope note: event_inbox is C0's (T0B-05) and is excluded from every count. lims_api / lims_worker INHERIT lims_app, so "no DELETE / no UPDATE" is asserted for lims_app only.
-- Policy counts per table (spec §8: 27 written out + shapes A-D + extras): see the rt table; sum 93.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

-- t: table; u: lims_app UPDATE; d: lims_app DELETE; npol: expected policies; aud: true = audit trigger required, false = forbidden, NULL = open; ctr: has the receiving-centre (SC) policies
CREATE TEMP TABLE rt(t, u, d, npol, aud, ctr) AS VALUES
  ('settings',true,false,4,true,false),('partners',true,false,5,true,false),('partner_users',true,false,7,true,false),('partner_referrers',true,false,6,true,false),('manifest_counters',true,false,6,NULL::boolean,false),
  ('manifests',true,false,6,true,true),('manifest_lines',true,true,9,true,true),('pickup_requests',true,false,6,true,true),('pickup_request_manifests',true,false,6,NULL::boolean,true),
  ('order_tracking',true,false,5,false,true),('tracked_specimens',true,false,4,false,true),('order_reports',true,false,7,false,true),('price_list_items',true,true,5,false,false),('price_list_syncs',true,false,4,false,false),
  ('statement_months',true,false,4,false,false),('download_counters',true,true,5,NULL::boolean,false),('access_slips',true,false,4,true,false),
  -- STALE fix T0B-GREEN-2: six tables added after this suite by migrations 20261117240000 (T0C-MSGDESK-1: partner_ticket, partner_ticket_message append-only) and 20261117210000 (T0C-SALES-1: sales_designation, sales_representative, party_sales_assignment, service_area)
  ('partner_ticket',true,false,6,true,false),('partner_ticket_message',false,false,4,NULL::boolean,false),('sales_designation',true,false,3,true,false),('sales_representative',true,false,3,true,false),
  ('party_sales_assignment',true,false,3,true,false),('service_area',true,false,3,true,false),
  -- re-pinned for T0C-PARTYSET-1 (LD-321): four tables added by migration 20261117220000, 3 policies each (select, insert, update; no DELETE), audit trigger
  ('party_commercial_setting',true,false,3,true,false),('party_onboarding',true,false,3,true,false),('non_compliance_penalty',true,false,3,true,false),('non_compliance_event',true,false,3,true,false);
CREATE TEMP TABLE rg(t) AS VALUES ('g_cs_reasons');

-- C13 check 1: partners, owner (AC-0B-1.2, AC-0B-6.3), schema privileges, no sequences / enums / views (§9)
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'partners'::regnamespace AND c.relkind IN ('r','p')), 27 + 1 + 1, 'C13 check 1: partners holds 27 tenant (17 + 2 partner_ticket* + 4 sales tables + 4 party settings tables, migrations 20261117240000 / 20261117210000 / 20261117220000) + 1 G table + event_inbox');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'partners'::regnamespace AND c.relkind IN ('v','m')), 0, 'C13 check 1 / §9: no view and no materialized view (C13 publishes none)');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'partners'::regnamespace AND c.relkind = 'S'), 0, 'C13 check 1: no sequences');
SELECT is((SELECT count(*)::int FROM pg_type t WHERE t.typnamespace = 'partners'::regnamespace AND t.typtype = 'e'), 0, 'C13 check 1: no ENUM types');
SELECT is(pg_get_userbyid(c.relowner), 'lims_owner', 'C13 check 1: partners.' || c.relname || ' owned by lims_owner (AC-0B-1.2, AC-0B-6.3)') FROM pg_class c WHERE c.relnamespace = 'partners'::regnamespace AND c.relkind = 'r';
SELECT is(has_schema_privilege('lims_app', 'partners', 'USAGE'), true, 'lims_app has USAGE on schema partners');
SELECT is(has_schema_privilege(r, 'partners', 'CREATE'), false, r || ' cannot CREATE in partners') FROM unnest(ARRAY['lims_app','lims_api','lims_worker','lims_analytics']) r;
SELECT is((SELECT array_agg(relname::text ORDER BY relname) FROM pg_class WHERE relnamespace = 'partners'::regnamespace AND relkind = 'r' AND relname <> 'event_inbox'), (SELECT array_agg(t ORDER BY t) FROM (SELECT t FROM rt UNION ALL SELECT t FROM rg) x), 'C13 check 1: the 28 tables = the 05-SCHEMA §8 DDL (18) + the 10 later approved tables');

-- C13 check 2: RLS ENABLE + FORCE on the 17 tenant tables, none on the G table (AC-0B-2.1, 2.4)
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = ('partners.' || t)::regclass), true, 'C13 check 2 / AC-0B-2.1: ENABLE + FORCE RLS on partners.' || t) FROM rt;
SELECT is((SELECT relrowsecurity OR relforcerowsecurity FROM pg_class WHERE oid = ('partners.' || t)::regclass), false, 'C13 check 2 / AC-0B-2.1: partners.' || t || ' is RLS-exempt (global coded set, listed in rls_exempt.txt)') FROM rg;
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'partners' AND tablename = g.t), 0, 'C13 check 2: no policy on ' || g.t) FROM rg g;
SELECT is(NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'partners'::regnamespace AND relkind = 'r' AND relname <> 'event_inbox' AND relname NOT LIKE 'g\_%' AND NOT (relrowsecurity AND relforcerowsecurity)), true, 'C13 check 2 / AC-0B-2.2 / AC-0B-2.4: no partners tenant table without FORCE RLS');
SELECT is((SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'partners' AND column_name = 'tenant_id' AND is_nullable = 'YES'), 0, 'C13 check 2 / AC-0B-3.5: tenant_id is NOT NULL everywhere');

-- C13 check 3: policy set per table (AC-0B-2.3)
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'partners' AND tablename = rt.t), npol, 'C13 check 3 / AC-0B-2.3: partners.' || t || ' has ' || npol || ' policies') FROM rt;
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'partners' AND tablename <> 'event_inbox'), 127, 'C13 check 3: 127 policies in partners (93 of §8 + 34 of the 10 later tables, ex event_inbox)');
SELECT is((SELECT array_agg(DISTINCT r ORDER BY r) FROM pg_policies p, unnest(p.roles) r WHERE schemaname = 'partners' AND tablename <> 'event_inbox'), ARRAY['lims_app'::name, 'lims_owner'::name], 'C13 check 3: policies are TO lims_app, plus the 7 __owner_only TO lims_owner; no PUBLIC / anon');
SELECT is((SELECT array_agg(policyname::text ORDER BY policyname) FROM pg_policies WHERE schemaname = 'partners' AND tablename <> 'event_inbox' AND roles = ARRAY['lims_owner'::name]),
  ARRAY['manifest_lines__select__owner_only','manifest_lines__update__owner_only','order_reports__select__owner_only','order_reports__update__owner_only','order_tracking__select__owner_only','partner_users__select__owner_only','partners__select__owner_only'], 'C13 check 3: the 7 owner policies of §8 (08 A10.5, A19 P-41)');
SELECT is((SELECT array_agg(tablename::text || '.' || policyname::text ORDER BY policyname) FROM pg_policies WHERE schemaname = 'partners' AND tablename <> 'event_inbox' AND cmd = 'DELETE'),
  ARRAY['download_counters.download_counters__delete__tenant','manifest_lines.manifest_lines__delete__partner','price_list_items.price_list_items__delete__system'], 'C13 check 3 / §5: the only DELETE policies');
SELECT matches((SELECT qual FROM pg_policies WHERE schemaname = 'partners' AND policyname = 'download_counters__delete__tenant'), 'expires_at < now\(\)', 'C13 check 3 / P-18(c): download_counters DELETE admits expired rows only');
SELECT matches((SELECT qual FROM pg_policies WHERE schemaname = 'partners' AND policyname = 'download_counters__delete__tenant'), 'is_staff_or_system', 'C13 check 3 / P-16: the only __tenant policy carries the staff guard');
SELECT matches((SELECT qual FROM pg_policies WHERE schemaname = 'partners' AND policyname = 'manifest_lines__delete__partner'), 'draft', 'C13 check 3: partner deletes draft lines only');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'partners' AND tablename <> 'event_inbox' AND (coalesce(qual, '') || coalesce(with_check, '')) NOT LIKE '%current_tenant_id%'), 0, 'C13 check 3: tenant predicate in every policy');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'partners' AND tablename <> 'event_inbox' AND policyname LIKE '%\_\_staff\_centre'), (SELECT count(*)::int * 3 FROM rt WHERE ctr AND t NOT IN ('order_tracking','tracked_specimens','order_reports')) + (SELECT count(*)::int FROM rt WHERE ctr AND t IN ('order_tracking','tracked_specimens','order_reports')), 'C13 check 3 / A16.1: staff_centre select + insert + update on the 4 shape-B SC tables, select only on the 3 shape-C projections (05-SCHEMA §8 shape table; writes are __system, asserted below)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'partners' AND policyname LIKE '%\_\_staff\_centre' AND (coalesce(qual, '') || coalesce(with_check, '')) NOT LIKE '%uuid[]%'), 0, 'C13 check 3 / A16.1: ::uuid[] cast in every centre predicate');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'partners' AND tablename IN ('order_tracking','tracked_specimens','price_list_items','price_list_syncs','statement_months') AND cmd IN ('INSERT','UPDATE','DELETE') AND policyname NOT LIKE '%\_\_system'), 0, 'C13 check 3: projections are written by the system actor only');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'partners' AND tablename = 'access_slips' AND cmd IN ('UPDATE','DELETE') AND policyname <> 'access_slips__update__system'), 0, 'C13 check 3: access_slips: UPDATE system only, no partner UPDATE, no DELETE');

-- C13 check 4: grant matrix (AC-0B-4.2 / 4.3; §5): DELETE on manifest_lines, price_list_items, download_counters only
SELECT is(has_table_privilege('lims_app', 'partners.' || t, 'SELECT'), true, 'C13 check 4: lims_app SELECT on partners.' || t) FROM rt;
SELECT is(has_table_privilege('lims_app', 'partners.' || t, 'INSERT'), true, 'C13 check 4 / AC-0B-4.2: lims_app INSERT on partners.' || t) FROM rt;
SELECT is(has_table_privilege('lims_app', 'partners.' || t, 'UPDATE'), u, 'C13 check 4 / AC-0B-4.1 / AC-0B-4.3: lims_app UPDATE on partners.' || t) FROM rt;
SELECT is(has_table_privilege('lims_app', 'partners.' || t, 'DELETE'), d, 'C13 check 4 / AC-0B-4.2 / §5: lims_app DELETE on partners.' || t || ' only for manifest_lines, price_list_items, download_counters') FROM rt;
SELECT is(has_table_privilege('lims_app', 'partners.' || t, 'TRUNCATE') OR has_table_privilege('lims_app', 'partners.' || t, 'REFERENCES') OR has_table_privilege('lims_app', 'partners.' || t, 'TRIGGER'), false, 'C13 check 4: no TRUNCATE / REFERENCES / TRIGGER on partners.' || t) FROM rt;
SELECT is(ARRAY[has_table_privilege('lims_app', 'partners.g_cs_reasons', 'SELECT'), has_table_privilege('lims_app', 'partners.g_cs_reasons', 'INSERT'), has_table_privilege('lims_app', 'partners.g_cs_reasons', 'UPDATE'), has_table_privilege('lims_app', 'partners.g_cs_reasons', 'DELETE')], ARRAY[true,false,false,false], 'C13 check 4: g_cs_reasons is SELECT only (owner writes)');
SELECT is(has_table_privilege('lims_analytics', 'partners.' || x.t, p), false, 'C13 check 4: lims_analytics has no ' || p || ' on partners.' || x.t) FROM (SELECT t FROM rt UNION ALL SELECT t FROM rg) x, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p;
SELECT is((SELECT count(*)::int FROM information_schema.role_table_grants WHERE table_schema = 'partners' AND grantee IN ('PUBLIC','anon','authenticated','service_role')), 0, 'C13 check 4: nothing granted to PUBLIC / anon / authenticated / service_role');
SELECT is(has_function_privilege('lims_app', 'app.current_partner_id()', 'EXECUTE'), true, 'C13 check 4: lims_app may EXECUTE app.current_partner_id()');
SELECT is(has_function_privilege('lims_worker', 'partners.redact_lines(uuid, timestamptz)', 'EXECUTE'), true, 'C13 check 4: lims_worker may EXECUTE partners.redact_lines');
SELECT is(has_function_privilege(r, 'partners.redact_lines(uuid, timestamptz)', 'EXECUTE'), false, 'C13 check 4: ' || r || ' may not EXECUTE partners.redact_lines (worker task only)') FROM unnest(ARRAY['lims_analytics']) r;
SELECT is((SELECT count(*)::int FROM pg_proc WHERE oid = 'partners.redact_lines(uuid, timestamptz)'::regprocedure AND proacl::text ~ '(^\{|,)=X/'), 0, 'C13 check 4: redact_lines REVOKE ALL FROM PUBLIC (a PUBLIC ACL item starts with =; lims_owner=X/ is the owner)');

-- C13 check 5: indexes + constraint names (§4, §8)
SELECT is((SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'partners' AND indexname IN ('partners__tenant_id_status__idx','partner_users__tenant_id_partner_id_status__idx','partner_referrers__tenant_id_partner_id_name_regno__p_uq','manifests__tenant_id_partner_id_created_at__idx',
  'manifests__tenant_id_receiving_centre_id_state__p_idx','manifest_lines__tenant_id_manifest_id_ref__p_uq','manifest_lines__tenant_id_order_id__p_uq','manifest_lines__patient_name_trgm__idx','manifest_lines__tenant_id_receiving_centre_id__missing__p_idx',
  'pickup_request_manifests__tenant_id_manifest_id__p_uq','order_tracking__tenant_id_partner_id_registered_at__idx','order_reports__tenant_id_partner_id_is_new__p_idx','access_slips__tenant_id_state_link_expires_at__p_idx','download_counters__tenant_id_expires_at__idx')), 14, 'C13 check 5: the named §4 indexes exist');
SELECT is((SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'partners' AND tablename <> 'event_inbox' AND indexdef NOT LIKE '%(tenant_id%' AND tablename NOT LIKE 'g\_%' AND indexname NOT LIKE '%\_pk'), 0, 'C13 check 5 / REQ-SEC-023: tenant_id leads every non-PK index');
SELECT is((SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'partners.pickup_request_manifests'::regclass AND contype = 'f'), 4, 'C13 check 5 / review #5: pickup link has pickup, manifest, partner and tenant FKs (a link can never join two partners)');
SELECT is((SELECT count(*)::int FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid WHERE r.relnamespace = 'partners'::regnamespace AND c.contype = 'f' AND c.conname = (r.relname || '__tenant__fk') AND r.relname <> 'event_inbox'), (SELECT count(*)::int FROM rt), 'C13 check 5 / C0 §9 rule 1: a tenant FK on every tenant table of rt (event_inbox is C0 and excluded)');
SELECT is((SELECT confmatchtype::text FROM pg_constraint WHERE conname = 'manifest_lines__referrer__fk'), 's', 'C13 check 5 / §3.5: referrer FK is MATCH SIMPLE (NULL referrer allowed)');
SELECT is((SELECT array_length(conkey, 1) FROM pg_constraint WHERE conname = 'access_slips__report__fk'), 4, 'C13 check 5 / §3.7a: access_slips -> order_reports is a 4-column partner-consistent FK');

-- C13 check 6: triggers + functions + audit (§6, §8, D-103)
SELECT is((SELECT array_agg(p.proname::text ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace = 'partners'::regnamespace),
  ARRAY['check_line_parent','guard_access_slip_update','guard_line_update','guard_manifest_update','guard_partner_columns','guard_partner_transitions','guard_partner_users','guard_report_seen','non_compliance_event__transition','party_onboarding__transition','party_sales_assignment__no_overlap','redact_lines','sales_representative__manager_guard'], 'C13 check 6: the 9 partners functions of §8 (+ app.current_partner_id) + the 2 sales trigger functions of migration 20261117210000 + the 2 party settings transition functions of migration 20261117220000');
SELECT is((SELECT array_agg(p.proname::text ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace = 'partners'::regnamespace AND p.prosecdef), ARRAY['redact_lines'], 'C13 check 6: redact_lines is the only DEFINER of the schema; guards are INVOKER');
SELECT is((SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'app.current_partner_id()'::regprocedure), true, 'C13 check 6: app.current_partner_id() is SECURITY DEFINER');
SELECT is(pg_get_userbyid(p.proowner), 'lims_owner', 'C13 check 6: ' || p.oid::regprocedure::text || ' owned by lims_owner') FROM pg_proc p WHERE p.pronamespace = 'partners'::regnamespace OR p.oid = 'app.current_partner_id()'::regprocedure;
SELECT matches(array_to_string(p.proconfig, ','), 'search_path=""', 'C13 check 6: ' || p.oid::regprocedure::text || ' has search_path = ''''') FROM pg_proc p WHERE p.pronamespace = 'partners'::regnamespace OR p.oid = 'app.current_partner_id()'::regprocedure;
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid::regclass::text LIKE 'partners.%' AND NOT t.tgisinternal AND t.tgname NOT LIKE '%\_\_audit'), 20, 'C13 check 6: the 14 §8 triggers + 2 __mutable_columns (migration 20261115200000) + 2 sales guards (migration 20261117210000) + 2 party settings transition guards (migration 20261117220000)');
SELECT is((SELECT array_agg(tgname::text ORDER BY tgname) FROM pg_trigger t WHERE t.tgrelid::regclass::text LIKE 'partners.%' AND NOT t.tgisinternal AND t.tgname NOT LIKE '%\_\_audit'),
  ARRAY['access_slips__guard','access_slips__mutable_columns','manifest_lines__guard','manifest_lines__parent','manifest_lines__partner_columns','manifest_lines__partner_transitions','manifests__guard','manifests__partner_columns','manifests__partner_transitions',
        'non_compliance_event__transition','order_reports__guard_seen','partner_referrers__partner_columns','partner_users__partner_columns','partner_users__partner_guard','party_onboarding__transition','party_sales_assignment__no_overlap','pickup_request_manifests__mutable_columns','pickup_requests__partner_columns','pickup_requests__partner_transitions','sales_representative__manager_guard'], 'C13 check 6: trigger names (§8 + 20261115200000 + 20261117210000 + 20261117220000)');
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid::regclass::text = 'partners.partner_users' AND t.tgname = 'partner_users__partner_guard' AND (t.tgtype & 4) <> 0 AND (t.tgtype & 16) <> 0), 1, 'C13 check 6: partner_users guard fires on INSERT and UPDATE');
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = ('partners.' || a.t)::regclass AND t.tgname = a.t || '__audit' AND NOT t.tgisinternal), 1, 'C13 check 6 / AC-0B-5.1: audit trigger on partners.' || a.t) FROM rt a WHERE a.aud IS TRUE;
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = ('partners.' || a.t)::regclass AND t.tgname = a.t || '__audit'), 0, 'C13 check 6 / §6: no audit trigger on projection partners.' || a.t) FROM rt a WHERE a.aud IS FALSE;
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid::regclass::text LIKE 'partners.%' AND NOT t.tgisinternal AND NOT t.tgenabled = 'O'), 0, 'C13 check 6: no trigger disabled');

-- C13 check 7: FK direction (AC-0B-6.2), seeds, no stand-in objects
SELECT is((SELECT array_agg(DISTINCT n.nspname::text ORDER BY n.nspname::text) FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_class f ON f.oid = c.confrelid JOIN pg_namespace n ON n.oid = f.relnamespace WHERE r.relnamespace = 'partners'::regnamespace AND c.contype = 'f'),
  ARRAY['catalog','core','frontdesk','partners'], 'C13 check 7 / AC-0B-6.2: partners FKs point into partners, core, catalog, frontdesk only');
SELECT is((SELECT count(*)::int FROM pg_constraint c JOIN pg_class f ON f.oid = c.confrelid WHERE f.relnamespace = 'partners'::regnamespace AND c.contype = 'f' AND c.conrelid::regclass::text NOT LIKE 'partners.%'), 0, 'C13 check 7 / AC-0B-6.2: no upstream schema references partners');
SELECT is((SELECT count(*)::int FROM partners.g_cs_reasons), 29, 'C13 check 7: 29 seeded coded-set rows (§7)');
SELECT is((SELECT count(DISTINCT set_name)::int FROM partners.g_cs_reasons), 7, 'C13 check 7: 7 coded sets');
SELECT is((SELECT count(*)::int FROM partners.g_cs_reasons WHERE requires_text), (SELECT count(*)::int FROM partners.g_cs_reasons WHERE code = 'other'), 'C13 check 7: requires_text exactly for other');
SELECT is((SELECT count(*)::int FROM partners.g_cs_reasons WHERE code = 'other'), 7, 'C13 check 7: every set has other');
SELECT is((SELECT count(*)::int FROM partners.settings), 0, 'C13 check 7 / P-22: no settings row is seeded (lazy)');
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.prosecdef AND p.pronamespace = 'partners'::regnamespace AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'partners' AND policyname LIKE '%\_\_owner\_only')), 0, 'C13 check 7 / A10.5: the DEFINER is backed by owner policies');

SELECT * FROM finish();
ROLLBACK;
