TESTS_WRONG — reports.live.test.ts pins the pre-LD-357 column name `net_billed_paisa` for three non-referral reports; the contract now names it `net_paisa`.

Change in services/api/src/modules/analytics/__tests__/misreports/reports.live.test.ts, rename the key `net_billed_paisa` -> `net_paisa` only (expected values, sums and register reconciliation unchanged):
- :172, :176, :186 (sales_representative)
- :262 (repeated_patient)
- :300, :303 (party_billing)
Keep :196-198 (consultant must not contain net_billed_paisa) unchanged.

Reasons:
1. contracts/openapi/analytics.yaml:3974 and :3976 (sales_representative column and default_sort), :4038 (repeated_patient), :4127 (party_billing) all declare `net_paisa` / title Net.
2. analytics.yaml:3951 and :1118: referral_incentive stays the only carrier of `net_billed_paisa` (D-44).
3. LD-357 (CR-C0-T0B-MISREPORTS-1 (2) option (a)): rename in exactly those three reports; "the registry and SQL follow the renamed contract; P13 stays".
4. spec/chunks/C8-analytics-mis/02-TRD.md:173 and 07-SECURITY.md P13 (lines 54, 98): net_billed_paisa only in referral_incentive — the test's old key contradicts them.
5. No assertion is loosened: same rows, same totals, same reconciliation; only the key follows the contract.
