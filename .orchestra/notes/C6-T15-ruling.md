TESTS_WRONG — `settings.handlers.test.ts:46-50` asserts the first 5 non-T03 operationIds are 501 stubs; `listReports` (R1) is now one of them and the spec puts it in C6-T15 scope, so the assertion is stale.
Reasons:
- spec/chunks/C6-reporting-delivery/06-IMPLEMENTATION-PLAN.md:27 — C6-T15 implements staff read endpoints R1–R5.
- spec/chunks/C6-reporting-delivery/02-TRD.md:559 — R1 = GET `/reports`, operationId `listReports`; it must be a real handler after T15, not a 501.
- The test's own header (line 4) says stub coverage for other ops belongs to manifest.test.ts, which already excludes implemented ops via its IMPLEMENTED set (manifest.test.ts:72,90).
Change in the test: build `others` by excluding T03_OPS *and* every already-implemented op (reuse/export the manifest.test.ts IMPLEMENTED set, or filter out ops whose handler is not the 501 stub registry), then keep the 501 check on the first 5 of that remaining list. Do not weaken it to a count-only check.
Also make sure manifest.test.ts IMPLEMENTED includes the R1–R5 operationIds T15 implements, so its 501 list stays exact.
The T15 contract tests themselves are not disputed and stay as they are.
