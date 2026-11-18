# T0B-MISREPORTS-1 dispute (writer, 2026-11-18)

TESTS_WRONG: services/api/src/modules/analytics/__tests__/misreports/reports.live.test.ts still pins the OLD column name `net_billed_paisa` for three non-referral reports, against the renamed contract (LD-357, CR-C0-T0B-MISREPORTS-1 (2) option (a)).

- Contract now on the lane: contracts/openapi/analytics.yaml:3974 (sales_representative column), :3976 (its default_sort), :4038 (repeated_patient), :4127 (party_billing) are all `net_paisa` / title Net. Only referral_incentive (:3951) keeps `net_billed_paisa` (D-44).
- LD-357: "the registry and SQL follow the renamed contract; P13 stays". The implementation is renamed accordingly (domain/misReports.ts, service/misReports.service.ts). registry.static (registry == contract) and probes/contract.probe.test.ts P13 (net_billed_paisa only in the referral files) both pass with the rename and both FAIL without it, so the live test cannot pass at the same time.
- Lines to fix (rename the key `net_billed_paisa` -> `net_paisa`, nothing else; the expected values stay identical):
  - reports.live.test.ts:172 and :176 and :186 (sales_representative)
  - reports.live.test.ts:262 (repeated_patient)
  - reports.live.test.ts:300 and :303 (party_billing)
- Line :196-198 (consultant has no net_billed_paisa) is correct and stays.
- No assertion is loosened: the same sums, the same reconciliation to the register, only the key name follows the contract.
