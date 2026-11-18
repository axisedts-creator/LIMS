# T0B-PRINTCFG-1 dispute (writer, 2026-11-18)
Test: services/api/src/modules/reporting/__tests__/printcfg/handlers.live.test.ts "every upsert is audited" (line 126):
`rows.some((x) => String(x.action).startsWith('reporting.print_profile.'))`.
Why it cannot pass: audit.access_log.action has FK -> audit.g_cs_access_actions.code, whose CHECK is `^[a-z_]+\.[a-z_]+$` (ONE dot;
db/migrations/20261105000600_audit__create_audit_tables.sql:10), and core/audit/access.ts rejects any other action before the insert (common.internal).
`reporting.print_profile.<x>` has two dots; no such code exists or can be seeded. Writer must not edit spec/seeds outside the chunk either.
Implemented instead [CONV]: action `settings.change` (existing seeded code), entity_type `print_profile` / `signatory_profile`, entity_id = row id, outcome allowed.
The other assertions of that test (>= 1 allowed row for the entity id) are met.
Proposed fix (tester / lead): assert `action === 'settings.change' && entity_type === 'print_profile'`, or a lead ruling adding codes such as `print_profile.change` and
`signatory_profile.change` to db/seeds/003_audit__g_cs_access_actions.sql (C0 owns seeds? then the writer adds them on that ruling).
Everything else of the task was implemented; this one assertion is expected red until ruled.

## 2. settings.handlers.test.ts:49 "the other reporting operations are still 501 stubs" (expects >= 1)
LD-325(b) / handlers.static.test.ts demand that T0B-PRINTCFG-1 implements the last 5 stubs, so `others` is now []. The test's own comment says:
"when the last stub is implemented, replace with expect(others).toEqual([])". Tester change, not mine (would be editing a test).

## 4. handlers.live.test.ts "previewPrintProfile: 202 with a render job"
A preview is a reporting.print_jobs row + app.enqueue_job('reporting.render_print'), exactly as previewReportTemplate (contract: "Same render job").
The fixture ctx has no working centre (print_jobs.centre_id NOT NULL; RLS print_jobs__insert__tenant_centre needs a centre claim or all-centres) and the
throwaway DB has an empty core.g_task_registry (run 2: `unknown_task_identifier` -> common.service_unavailable). Fix: give ctx a centreId + centre claim and
seed the registry row (or register tasks as the worker does). Code fails closed (common.internal) without a centre, like previewReportTemplate.
The id-refusal half of the test (patient_id / order_id / invoice_id / report_version_id / markup -> validation_failed) is enforced before any DB access.

## 3. billing/service/__tests__/printcfg.live.test.ts beforeAll fails: `chronology_violation` (P0001)
The fixture inserts billing.invoices INV:PCFG seq 1..3 for FY 2097/98 but no billing.fiscal_counters row; trigger
(20261105001700_billing__create_billing_schema.sql:183-191) requires counter last_no = NEW.invoice_seq. Fix: insert/upsert the counter
(last_no = seq) before each invoice in the fixture, like the other billing live fixtures. The service code under test is done (style stored, original
style kept on reprint via getOriginalPrintStyle); its unit tests (printcfg.service, print.service) are green.
