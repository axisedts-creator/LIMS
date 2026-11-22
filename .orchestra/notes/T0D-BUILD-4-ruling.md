TESTS_WRONG — registry.static.test.ts:97 and probes/coverage.probe.test.ts:64 pin 30 analytics operations; the task contract now has 31 (30 + getMisReportPage), so the pins are stale counts, not requirements.
Reasons:
1. spec/chunks/C8-analytics-mis/06-IMPLEMENTATION-PLAN.md:11 and 02-TRD.md:901 say "all 30 operations" = every operation of analytics.yaml mapped/probed; the requirement is "all", the number was the count at that time.
2. LD-447 (binding for this task, task brief item (1)) adds exactly ONE additive GET getMisReportPage; contracts/openapi/analytics.yaml now has 31 operationId entries (getMisReportPage at line 3911).
3. The tester already moved the same pin 30 -> 31 in boot.test.ts:84-85,246 and probes/contract.probe.test.ts:21-22 (notes/T0D-BUILD-4-tests.md "count only"); these two were missed.
CHANGE (tester), count only, keep every other assertion:
- registry.static.test.ts:96-97: title "30 operations" -> "31 operations (30 + getMisReportPage, T0D-BUILD-4)"; `toHaveLength(30)` -> `toHaveLength(31)`. Keep the handlers == OPS equality and the no-pendingOperations test unchanged.
- coverage.probe.test.ts describe title ("P1 \"all 30 operations\"") and lines 63-64: "all 30 operations" -> "all 31 operations"; `toBe(30)` -> `toBe(31)`. Keep the OPS.map check.
The implementation needs no change for this point.


## LEAD ITEM (LD-452, 2026-11-22 15:26 NPT)
(1) Boot test timeout: the TESTER raises the per-test cap of AN-T01 boot to 300000 (same as vitest.config) and changes nothing else; writer and debugger do not edit it. (2) REVIEWER: check the regenerated tests/security/authz-classification.json against main (no operation became unguarded; the one unguarded entry is a known public operation) and prove by tests that the per-code checks of getMisReportPage hold (money codes: auth.forbidden without analytics.referral_report.read, auth.mfa_required without aal2, a code the caller may not export is refused like its export). Not proven by a test = CHANGES. Reviewer edits nothing.
