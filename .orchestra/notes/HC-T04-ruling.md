TESTS_WRONG — the test asserts something the spec does not require
Change in `services/api/src/modules/homecollection/__tests__/boot.test.ts:39`:
  `const IMPLEMENTED: readonly string[] = ['getHomecollectionSettings', 'updateHomecollectionSettings', 'listHomecollectionReasons'];`
Reasons:
- spec/chunks/C17-home-collection/06-IMPLEMENTATION-PLAN.md:24 (HC-T01): 501 stubs are a skeleton state ("empty handlers for every operationId"), not a lasting requirement.
- 06-IMPLEMENTATION-PLAN.md:27 (HC-T04): H18–H20 must be real (lazy settings row, TRD defaults, seed reasons, D-128/D-129 rejections), so they can no longer answer 501 / common.internal.
- boot.test.ts:38 itself says a later task moves its ids into IMPLEMENTED (tester-owned); HC-T04 tester did not, so the stub tests are stale, not the implementation.
- Leave every other stub assertion unchanged: the remaining 23 ops must still answer 501 in dev and common.internal in staging/production.
- The 30 s timeout on "boots and mounts ... (26 of 26)" (boot.test.ts:212) is not tied to a spec rule. No ruling on it: the tester should rerun it alone, and raise it as a separate defect only if it reproduces.
