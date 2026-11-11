TESTS_WRONG — the test timeouts (30 s vitest, 60 s Playwright) are not spec requirements and fail on cold module load only, never on an assertion.
Reasons:
1. LD-91 (2026-11-11, binding for C6-T42, in task brief) rules TESTS_WRONG on timeouts only; it overrides spec text for this task.
2. Spec sets no test timeout: grep `testTimeout|test timeout` over spec/ returns only the PDF render timeout (spec/research/03-backend-architecture.md:205, :410; spec/research/04-consolidated-decisions.md:30), unrelated to test harness limits.
3. Done-when (spec/chunks/C6-reporting-delivery/06-IMPLEMENTATION-PLAN.md:50, :113) requires 02-TRD s14 "Review fix pass" (n) green; it sets no wall-clock budget. api 31/31, worker 23/23, static 5/5 pass on assertions.
4. Cause is the jsdom pre-warm in domain/sanitise.ts (C6-T33 [CONV]), 25-60 s cold on a shared machine; not an implementation defect.
TESTER changes ONLY these lines:
- services/api/src/modules/reporting/__tests__/portal.payment.test.ts:12 -> `vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });`
- services/worker/src/jobs/reporting/__tests__/portal_payment.tasks.test.ts:11 -> `vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });`
- tests/portal-e2e/playwright.pay.config.ts:14 -> `timeout: 120_000,` (webServer timeouts at :17 and :22 unchanged)
No assertion, fixture or other test line changes. sanitise.ts and the implementation stay unchanged.
