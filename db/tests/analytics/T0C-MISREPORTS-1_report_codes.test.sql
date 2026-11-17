-- T0C-MISREPORTS-1 pgTAP suite (LD-321; founder blanket authority LD-310; priority 2026-11-17 09:18 NPT) for migration 20261117230000_analytics__add_mis_report_support.sql:
-- the new MIS report codes are rows of the existing global coded set analytics.g_cs_report_codes (so exports.report_code FK and the schedules_codes_guard accept them, no new route).
-- Covers: the 14 original codes untouched, the new codes present (exportable and schedulable), wire shape (^[a-z_]{2,40}$, <= 32 chars as in analytics.yaml), the 04 L19 "no commission word" check
-- relaxed for the two commission reports only by the founder order (the other checks stay), grants unchanged (lims_app SELECT only), no table or column added, idempotent re-apply.
-- Synthetic data only. One rolled-back transaction. RLS is not involved (class G table, rls_exempt.txt).
-- Run: bash db/tests/run-suites.sh db/tests/analytics/T0C-MISREPORTS-1_report_codes.test.sql   (docker; migrations + seeds loaded)
-- ASSUMPTION (a different choice needs a ruling, not a silent test edit): the new codes are exactly the 9 pinned in tools/codegen/__tests__/misreports1-openapi.test.ts (NEW_CODES) plus any
-- the implementer adds from the field map; this suite pins the 9 and only requires that the rest are well formed.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE TEMP TABLE orig(code) AS VALUES ('dashboard'),('income'),('department_income'),('collections'),('volume'),('top_referrers'),('top_centres'),('referral_incentive'),
  ('tests_done'),('tat'),('pending_tests'),('quality_indicators'),('delivery'),('interfaces');
CREATE TEMP TABLE pinned(code) AS VALUES ('bill_of_the_day'),('two_level_commission'),('sales_representative'),('consultant'),('collection_boy'),
  ('repeated_patient'),('repeated_test'),('ipd_opd'),('tds');

SELECT is((SELECT count(*)::int FROM analytics.g_cs_report_codes g JOIN orig o USING (code)), 14, 'the 14 original report codes are still present');
SELECT is((SELECT is_schedulable FROM analytics.g_cs_report_codes WHERE code = 'interfaces'), false, 'interfaces is still not schedulable');
SELECT is((SELECT count(*)::int FROM analytics.g_cs_report_codes WHERE code NOT IN (SELECT code FROM orig) AND NOT is_schedulable), 0, 'every new report is schedulable');
SELECT is((SELECT count(*)::int FROM analytics.g_cs_report_codes WHERE code NOT IN (SELECT code FROM orig) AND NOT is_exportable), 0, 'every new report is exportable');
SELECT cmp_ok((SELECT count(*)::int FROM analytics.g_cs_report_codes), '>=', 14 + 9, 'at least the 9 pinned reports were added');
SELECT is((SELECT count(*)::int FROM analytics.g_cs_report_codes g JOIN pinned p USING (code)), 9, 'all 9 pinned codes are rows of the coded set');
SELECT is((SELECT count(*)::int FROM analytics.g_cs_report_codes g JOIN pinned p USING (code) WHERE g.is_active), 9, 'all 9 pinned codes are active');
SELECT is((SELECT count(*)::int FROM analytics.g_cs_report_codes WHERE code NOT IN (SELECT code FROM orig) AND (code !~ '^[a-z_]{2,32}$' OR btrim(display) = '' OR system <> 'lims')), 0,
  'every new code fits the wire pattern (<= 32 chars, letters and underscore), has a display text and system lims');
SELECT is((SELECT count(DISTINCT sort_order)::int FROM analytics.g_cs_report_codes), (SELECT count(*)::int FROM analytics.g_cs_report_codes), 'sort_order stays unique per code (stable catalogue order)');

-- 04 L19: the old check forbade the word; the founder order (LD-310 / LD-321) asks for a commission report, so the check is relaxed, but the code pattern check stays
SELECT is((SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'analytics.g_cs_report_codes'::regclass AND conname = 'g_cs_report_codes__code__ck'), 1, 'the code pattern check g_cs_report_codes__code__ck still exists');
SELECT is((SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'analytics.g_cs_report_codes'::regclass AND conname = 'g_cs_report_codes__no_c_word__ck' AND pg_get_constraintdef(oid) ~* 'commission'
   AND pg_get_constraintdef(oid) !~* 'two_level_commission|tds'), 0, 'the old blanket "commission" ban is gone (it would reject two_level_commission)');
SELECT is((SELECT count(*)::int FROM analytics.g_cs_report_codes WHERE code = 'two_level_commission'), 1, 'two_level_commission exists');
SELECT throws_ok($$INSERT INTO analytics.g_cs_report_codes (code, display) VALUES ('Bad Code 1', 'x')$$, '23514', NULL, 'the code pattern check still refuses a malformed code');
SELECT throws_ok($$INSERT INTO analytics.g_cs_report_codes (code, display) VALUES ('bill_of_the_day', 'again')$$, '23505', NULL, 'a code is unique (primary key)');

-- consumers of the set
SELECT is((SELECT count(*)::int FROM pg_constraint WHERE conname = 'exports__report__fk' AND confrelid = 'analytics.g_cs_report_codes'::regclass), 1, 'exports.report_code still references the coded set (new codes become exportable with no new table)');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname = 'schedules_codes_guard' AND pronamespace = 'analytics'::regnamespace), 1, 'schedules_codes_guard still reads the coded set (new codes become schedulable)');

-- no structural change: the coded set keeps its 8 columns, the analytics schema keeps its 26 tenant + 2 global tables, grants stay SELECT only
SELECT is((SELECT count(*)::int FROM pg_attribute WHERE attrelid = 'analytics.g_cs_report_codes'::regclass AND attnum > 0 AND NOT attisdropped), 8, 'g_cs_report_codes keeps its 8 columns (no supporting column was needed)');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'analytics'::regnamespace AND c.relkind IN ('r','p')), 26 + 2 + 1, 'analytics holds the same 26 tenant + 2 global tables + event_inbox');
SELECT is(has_table_privilege('lims_app', 'analytics.g_cs_report_codes', 'SELECT'), true, 'lims_app can read the coded set');
SELECT is(has_table_privilege('lims_app', 'analytics.g_cs_report_codes', 'INSERT') OR has_table_privilege('lims_app', 'analytics.g_cs_report_codes', 'UPDATE') OR has_table_privilege('lims_app', 'analytics.g_cs_report_codes', 'DELETE'), false,
  'lims_app cannot write the coded set (the catalogue changes only by migration)');
SELECT is(pg_get_userbyid(relowner), 'lims_owner', 'the coded set stays owned by lims_owner') FROM pg_class WHERE oid = 'analytics.g_cs_report_codes'::regclass;

-- idempotent re-apply: a second run changes nothing and keeps hand-set flags
UPDATE analytics.g_cs_report_codes SET display = display WHERE code = 'tds';
CREATE FUNCTION pg_temp.state() RETURNS text LANGUAGE sql AS $$
  SELECT concat_ws('|',
    (SELECT count(*) FROM analytics.g_cs_report_codes),
    (SELECT string_agg(code || ':' || display || ':' || is_exportable || ':' || is_schedulable || ':' || sort_order, ';' ORDER BY code) FROM analytics.g_cs_report_codes),
    (SELECT count(*) FROM pg_constraint WHERE connamespace = 'analytics'::regnamespace),
    (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind = 'r' AND c.relnamespace = 'analytics'::regnamespace)) $$;
CREATE TEMP TABLE before_state AS SELECT pg_temp.state() AS s;
\ir ../../migrations/20261117230000_analytics__add_mis_report_support.sql
RESET ROLE;
SELECT is(pg_temp.state(), (SELECT s FROM before_state), 're-apply: codes, displays, flags, sort order, constraints and columns are unchanged');
SELECT is(has_table_privilege('lims_app', 'analytics.g_cs_report_codes', 'INSERT'), false, 're-apply keeps the coded set read only for lims_app');

SELECT * FROM finish();
ROLLBACK;
