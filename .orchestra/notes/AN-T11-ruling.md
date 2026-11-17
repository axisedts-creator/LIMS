TESTS_WRONG — boot.test.ts:39 `IMPLEMENTED` list is stale; it still treats the four AN-T11 handlers as stubs.
Change: `services/api/src/modules/analytics/__tests__/boot.test.ts:39` — append 'getTestsDoneReport', 'getQualityIndicatorsReport', 'getDeliveryReport', 'getInterfacesReport' to `IMPLEMENTED` (comment: AN-T11). No other change.
Reasons:
- spec/chunks/C8-analytics-mis/06-IMPLEMENTATION-PLAN.md:11 — AN-T01 stubs are a temporary skeleton ("handlers stubs ... returning 501 only in dev"); later tasks replace them.
- spec/chunks/C8-analytics-mis/06-IMPLEMENTATION-PLAN.md:21 — AN-T11 owns exactly these four handlers (`getTestsDoneReport`, `getQualityIndicatorsReport`, `getDeliveryReport`, `getInterfacesReport`), so they must no longer behave as 501/common.internal stubs.
- boot.test.ts:38 itself specifies the mechanism: "that task moves its ids here (tester-owned list)" — AN-T08 already did so for its ids.
- Writer's dispute does not contest the AN-T11 integration tests; implementation is not at fault.
