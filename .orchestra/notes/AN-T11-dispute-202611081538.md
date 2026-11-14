# AN-T11 dispute (writer)
Not a disagreement with the T11 tests (all 6 pass). Stale tester-owned list: `services/api/src/modules/analytics/__tests__/boot.test.ts:39` `IMPLEMENTED = ['getIncomeReport', 'getDepartmentIncomeReport']` (its own comment: "that task moves its ids here").
AN-T11 implements `getTestsDoneReport`, `getQualityIndicatorsReport`, `getDeliveryReport`, `getInterfacesReport`, so the two stub tests (dev 501 / staging common.internal) now fail for those ids.
Fix (tester): append the four ids to `IMPLEMENTED`. No other change needed.
