TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons:
- `services/api/src/modules/reporting/__tests__/settings.handlers.test.ts:49` asserts `others.length >= 5` stubs remain. No spec line requires any number of reporting operations to stay 501; the floor is a test-internal anti-vacuity guard (its own comment says so), not a requirement.
- spec/chunks/C6-reporting-delivery/06-IMPLEMENTATION-PLAN.md:28 (row C6-T16) assigns R10–R13 and T5 to this task; contracts/openapi/reporting.yaml:917,1006,1061,1135,4121 define createReportPrint, getReportPrint, downloadReportPrintPdf, createBulkPrint, previewReportTemplate. Making them real handlers is required, so the stub inventory legitimately shrinks to 3.
- The tester's own C6-T16 commit (e4514fb6) added those five ids to `__tests__/implemented-ops.ts`, which is what drops the count below 5. The test contradicts that file.
Change (tester), lines 49-50: replace `toBeGreaterThanOrEqual(5)` with `toBeGreaterThanOrEqual(1)` and keep the `others.slice(0, 5)` loop as it is (it checks every remaining stub when fewer than 5 are left, and never runs vacuously while at least 1 remains). Update the comment ("3 remain stubs after T16"). If a later task implements the last stub, that task's tester replaces the assertion with `expect(others).toEqual([])`.
Implementation: no change required by this ruling.
Not verified: the vitest run hit a cold-import `beforeAll` timeout (10s) in this session. The count of 3 comes from the dispute, not from my own run.
