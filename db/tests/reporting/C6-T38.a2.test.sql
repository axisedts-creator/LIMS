-- C6-T38 live-DB twin of 02-TRD §14 row "08 Addendum A2" (a), (d), (g): report_versions__smart_summary__ck (all-or-none), otp_challenges__hmac__ck (bytea, 32 bytes),
-- g_message_templates__code__ck accepts analytics.report_ready. Constraint-level: each case is a failing INSERT/UPDATE caught as an SQLSTATE; no fixtures needed
-- beyond the check expressions, so the CHECKs are evaluated through a scratch table built from the same pg_get_constraintdef text (no RLS / FK dependencies).
-- Run: pg_prove -d <db> db/tests/reporting/C6-T38.a2.test.sql   (pgTAP in schema `extensions`; migrations loaded; superuser). NOT run in the tester sandbox (no Postgres).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE TEMP TABLE sv (j jsonb, i uuid, v text);
CREATE TEMP TABLE oc (h bytea);
CREATE TEMP TABLE tc (code text);
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint WHERE conname = 'report_versions__smart_summary__ck' AND conrelid = 'reporting.report_versions'::regclass;
  EXECUTE 'ALTER TABLE sv ADD CONSTRAINT ck ' || replace(replace(replace(d, 'smart_summary_json', 'j'), 'smart_summary_id', 'i'), 'smart_summary_version', 'v');
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint WHERE conname = 'otp_challenges__hmac__ck' AND conrelid = 'reporting.otp_challenges'::regclass;
  EXECUTE 'ALTER TABLE oc ADD CONSTRAINT ck ' || replace(d, 'code_hmac', 'h');
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint WHERE conname = 'g_message_templates__code__ck' AND conrelid = 'reporting.g_message_templates'::regclass;
  EXECUTE 'ALTER TABLE tc ADD CONSTRAINT ck ' || replace(d, 'code ~', 'code ~');
END $$;

-- (a) the 8 NULL/non-NULL combinations of (json, id, version): only all-NULL and all-set pass
SELECT lives_ok($$INSERT INTO sv VALUES (NULL, NULL, NULL)$$, 'A2(a) all NULL accepted');
SELECT lives_ok($$INSERT INTO sv VALUES ('{"a":1}', gen_random_uuid(), 'lib-1')$$, 'A2(a) all set accepted');
SELECT throws_ok($$INSERT INTO sv VALUES ('{"a":1}', NULL, NULL)$$, '23514', NULL, 'A2(a) json only rejected');
SELECT throws_ok($$INSERT INTO sv VALUES (NULL, gen_random_uuid(), NULL)$$, '23514', NULL, 'A2(a) id only rejected');
SELECT throws_ok($$INSERT INTO sv VALUES (NULL, NULL, 'lib-1')$$, '23514', NULL, 'A2(a) version only rejected');
SELECT throws_ok($$INSERT INTO sv VALUES ('{"a":1}', gen_random_uuid(), NULL)$$, '23514', NULL, 'A2(a) json+id (2 of 3) rejected');
SELECT throws_ok($$INSERT INTO sv VALUES ('{"a":1}', NULL, 'lib-1')$$, '23514', NULL, 'A2(a) json+version (2 of 3) rejected');
SELECT throws_ok($$INSERT INTO sv VALUES (NULL, gen_random_uuid(), 'lib-1')$$, '23514', NULL, 'A2(a) id+version (2 of 3) rejected');
SELECT throws_ok($$INSERT INTO sv VALUES ('[1]', gen_random_uuid(), 'lib-1')$$, '23514', NULL, 'A2(a) non-object json rejected');
SELECT throws_ok($$INSERT INTO sv VALUES ('{}', gen_random_uuid(), '')$$, '23514', NULL, 'A2(a) empty version rejected');
SELECT throws_ok($$INSERT INTO sv VALUES ('{}', gen_random_uuid(), repeat('x', 33))$$, '23514', NULL, 'A2(a) 33-char version rejected');
SELECT lives_ok($$INSERT INTO sv VALUES ('{}', gen_random_uuid(), repeat('x', 32))$$, 'A2(a) 32-char version accepted');
-- (a) UPDATE of any of the three is refused by the mutable-columns trigger (P0001 / EP0001 immutable_row as in T0B-10.C6 behaviour test)
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = 'reporting.report_versions'::regclass AND t.tgname = 'report_versions__mutable_columns'), 1, 'A2(a) mutable-columns trigger present');
SELECT is((SELECT pg_get_triggerdef(t.oid) ~ 'smart_summary' FROM pg_trigger t WHERE t.tgname = 'report_versions__mutable_columns' AND t.tgrelid = 'reporting.report_versions'::regclass), false, 'A2(a) smart_summary_* not in the mutable list');

-- (d) code_hmac: bytea, NULL or exactly 32 bytes
SELECT is((SELECT data_type FROM information_schema.columns WHERE table_schema = 'reporting' AND table_name = 'otp_challenges' AND column_name = 'code_hmac'), 'bytea', 'A2(d) code_hmac is bytea');
SELECT lives_ok($$INSERT INTO oc VALUES (decode(repeat('ab', 32), 'hex'))$$, 'A2(d) 32 bytes accepted');
SELECT lives_ok($$INSERT INTO oc VALUES (NULL)$$, 'A2(d) NULL accepted (cleared state)');
SELECT throws_ok($$INSERT INTO oc VALUES (decode(repeat('ab', 31), 'hex'))$$, '23514', NULL, 'A2(d) 31 bytes rejected');
SELECT throws_ok($$INSERT INTO oc VALUES (decode(repeat('ab', 33), 'hex'))$$, '23514', NULL, 'A2(d) 33 bytes rejected');
SELECT throws_ok($$INSERT INTO oc VALUES (decode(repeat('ab', 64), 'hex'))$$, '23514', NULL, 'A2(d) 64 bytes (hex text stored as bytes) rejected');

-- (g) template code
SELECT lives_ok($$INSERT INTO tc VALUES ('analytics.report_ready')$$, 'A2(g) analytics.report_ready passes g_message_templates__code__ck');
SELECT throws_ok($$INSERT INTO tc VALUES ('analytics_report_ready')$$, '23514', NULL, 'A2(g) the old code (no dot) is rejected');
SELECT is((SELECT count(*)::int FROM reporting.g_message_templates WHERE code = 'analytics.report_ready' AND purpose = 'scheduled_report_ready'), 1, 'A2(g) seeded once with purpose scheduled_report_ready');
SELECT is((SELECT count(*)::int FROM reporting.g_message_templates WHERE code = 'analytics_report_ready'), 0, 'A2(g) old code not seeded');

SELECT * FROM finish();
ROLLBACK;
