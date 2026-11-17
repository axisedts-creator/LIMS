APPROVE

Re-review of `git diff 54a036e..HEAD` (BL-T08) after review fixes (b0553ff tester, 4ed5e70 writer).

1. Prior item 1 (B18 refund rows): fixed. `ledger.repo.ts` listLedgerForDay now selects `entry_kind IN ('payment', 'reversal', 'refund')`; `ledgerRead.service.ts:120` counts refund as reversal; test `ledger.reads.handlers.test.ts:203` covers a refund row (reversals, reversed, net) and matches the `billing.v_pub_payment_collection` rule.
2. Prior item 2 (gateway rows): CR-C4-BL08-003 filed in `.orchestra/cr/BL-T08.nonblocking.md` (To: C0, DailyCash); exclusion marked [CONV] in the ledgerRead.service.ts header.
3. Earlier checks still hold: names verbatim, tenant scoping, error codes, overpay manual/home, RC numbering from TenantSettings, one open session, home/B22 have no session, no PHI or secrets, only C4 billing paths touched.

Ran: `vitest run src/modules/billing`: 705 passed, 45 skipped (live DB), 0 failed.

Non-blocking: the doc comment above listLedgerForDay (`ledger.repo.ts:74`) still says "payment/reversal rows". Update it to include refund when that file is next edited.
