CHANGES

Scope reviewed: `git diff 54a036e..HEAD` (BL-T08). Names, columns (05-SCHEMA ledger_entries / cash_sessions / cs_payment_methods), error codes (contracts/errors.yaml), REQ-SEC-056 regex (= `ledger_entries__ref__ck`), overpay manual/home, RC numbering from `TenantSettings.numbering.receiptNoPattern`, one open session per (membership, centre) with ON CONFLICT on `cash_sessions__tenant_id_open__p_uq`, home/B22 no session, own-session close, tenant scoping on every query: OK. No migrations/RLS in this diff. No PHI or reference text in activity details. Only C4 billing paths touched.

1. B18 leaves out refund rows, so the daily-cash grid does not match the ledger or `billing.v_pub_payment_collection` (01-PRD US-BL-11.1: "match the ledger exactly and equal `billing.v_pub_payment_collection`"; 05-SCHEMA:1790-1793 counts `entry_kind IN ('reversal','refund')` as reversals/reversed and nets them). A refund pay-out (TRD §6.5, manual, has a collector and a cash session) never lowers B18 `net`, so B18 overstates cash.
   Fix:
   - `services/api/src/modules/billing/repository/ledger.repo.ts` (listLedgerForDay): `"l.entry_kind IN ('payment', 'reversal')"` -> `"l.entry_kind IN ('payment', 'reversal', 'refund')"`.
   - `services/api/src/modules/billing/service/ledgerRead.service.ts:119`: `else if (r['entry_kind'] === 'reversal')` -> `else if (r['entry_kind'] === 'reversal' || r['entry_kind'] === 'refund')`; update the header comment at lines 3-4.
   - Tester: `handlers/__tests__/ledger.reads.handlers.test.ts:12` pins the wrong rule ("refund rows are not part of the B18 grid"); change it to the view's rule and add a case with one refund row (counted in `reversals`, `reversed`, and subtracted from `net`).

2. Gateway rows (`collected_by_membership_id IS NULL`, 08 R8) are dropped from B18 (`ledger.repo.ts` listLedgerForDay `l.collected_by_membership_id IS NOT NULL`), but the view groups them under a NULL collector, so totals will differ from `v_pub_payment_collection` once C15 posts gateway money. B18 `rows[].collected_by` is a required Actor, so this is a spec gap, not a code fix. The writer noted it as "(a) no CR yet" in `.orchestra/cr/BL-T08.nonblocking.md`.
   Fix: writer adds CR-C4-BL08-003 to `.orchestra/cr/BL-T08.nonblocking.md` (To: C0, contracts/openapi/billing.yaml DailyCash): either make `collected_by` nullable for gateway rows, or add a `gateway` totals row. Keep the current exclusion until the ruling, and mark it [CONV] in the ledgerRead.service.ts header.

Not blocking (noted only): a missing `receiptNoPattern` maps to `billing.numbering_pattern_invalid`, which the registry defines for the invoice `{branch}` case. That is acceptable as fail-closed, but it is worth a line in the CR file.
