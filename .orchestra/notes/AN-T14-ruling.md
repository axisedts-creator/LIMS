TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

1. spec/chunks/C8-analytics-mis/06-IMPLEMENTATION-PLAN.md:11 — stubs answer `501` only until implemented; :24 makes AN-T14 implement `getAnalyticsDashboard`, `getAnalyticsFreshness`, `requestAnalyticsRefresh`. So boot.test.ts must stop treating them as stubs.
   Change: `services/api/src/modules/analytics/__tests__/boot.test.ts` IMPLEMENTED list (line ~44) — add
   `'getAnalyticsDashboard', 'getAnalyticsFreshness', 'requestAnalyticsRefresh', // AN-T14` (same pattern as AN-T08..T12).
2. No spec line sets a 5 s per-test budget; the plan's perf requirement for AN-T14 is a separate "perf smoke" (06-IMPLEMENTATION-PLAN.md:24), not the first test's cold-import + first Ajv compile time.
   Change: in `handlers/__tests__/dashboard.handler.test.ts` and `handlers/__tests__/freshness.handler.test.ts` add a `beforeAll` warm-up
   (import handlers + one `contractErrors('DashboardDto', {})` call) with a 30 000 ms hook timeout. Do NOT loosen any assertion.
No logic assertion is disputed; implementation stays as is.
