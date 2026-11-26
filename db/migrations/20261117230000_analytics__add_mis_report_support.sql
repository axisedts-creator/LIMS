-- cr-approved-breaking: owner decision 2026-11-26 (PR 9) accepts the DROP in this already merged migration.
-- T0C-MISREPORTS-1 (LD-321; founder blanket authority LD-310; priority 2026-11-17 09:18 NPT): the missing ElabAssist MIS reports
-- become ROWS of the existing global coded set analytics.g_cs_report_codes, so exports.report_code (FK) and
-- analytics.schedules_codes_guard() accept them with no new route, table, column or index. Definitions: contracts/openapi/analytics.yaml
-- x-report-definitions. New codes: bill_of_the_day, two_level_commission, sales_representative, consultant, collection_boy,
-- repeated_patient, repeated_test, ipd_opd, tds, party_billing, outsource.
-- 04 L19: the original check g_cs_report_codes__no_c_word__ck forbade the word commission in codes and displays. The founder order
-- (LD-310 / LD-321) asks for a two level commission report, so that one check is relaxed here (dropped); the code pattern check
-- g_cs_report_codes__code__ck and the primary key stay.
-- Additive, no data rewrite: only INSERT ... ON CONFLICT (code) DO NOTHING (re-apply keeps hand-set rows) and DROP CONSTRAINT IF EXISTS.
-- Founder step: push-cloud this migration after merge.
-- down: DELETE FROM analytics.g_cs_report_codes WHERE code IN (the 11 codes above); then re-add the check
--   ALTER TABLE analytics.g_cs_report_codes ADD CONSTRAINT g_cs_report_codes__no_c_word__ck CHECK (code !~* 'commission' AND display !~* 'commission');
SET LOCAL ROLE lims_owner;

ALTER TABLE analytics.g_cs_report_codes DROP CONSTRAINT IF EXISTS g_cs_report_codes__no_c_word__ck;

INSERT INTO analytics.g_cs_report_codes (code, display, sort_order, is_exportable, is_schedulable) VALUES
  ('bill_of_the_day', 'Bill of the Day', 150, true, true),
  ('two_level_commission', 'Two level commission', 160, true, true),
  ('sales_representative', 'Sales representative', 170, true, true),
  ('consultant', 'Consultant', 180, true, true),
  ('collection_boy', 'Collection boy', 190, true, true),
  ('repeated_patient', 'Repeated patient', 200, true, true),
  ('repeated_test', 'Repeated test', 210, true, true),
  ('ipd_opd', 'IPD and OPD', 220, true, true),
  ('tds', 'TDS', 230, true, true),
  ('party_billing', 'Party billing', 240, true, true),
  ('outsource', 'Outsource and inter lab transfer', 250, true, true)
ON CONFLICT (code) DO NOTHING;
