Title: CR-C0-ACCT-2: getDailyCollectionSummary signed net vs minimum 0 on DailyCollectionRow / DailyCollectionSummary
From chunk: C0 (task T0B-ACCT-2, lane C0-0B)            To owner: C0-0C (contracts/openapi/billing.yaml, T0C-ACCT-1 block)
Type: api
Blocking? yes — T0B-ACCT-2 review item 1 (notes/T0B-ACCT-2-review.md) and test dailySummary.test.ts "a refund-only day (payment on D-1, reversal on D) gives a response that satisfies the DailyCollectionSummary contract" cannot pass without a ruling. The writer must not pick a side (reviewer).

Problem (what you cannot do today, with the user story / acceptance criterion it serves):
done_when (4): the daily collection summary "matches the billing daily cash numbers for the same day". getDailyCash nets refunds and reversals by business_date, so a refund on day D for a bill paid on D-1 gives a negative net for that payment mode on D (implementation: services/api/src/modules/billing/repository/expenses.repo.ts:98-102, entry_count -1, total_paisa -abs(amount)). contracts/openapi/billing.yaml:9587-9595 (DailyCollectionRow.entry_count, DailyCollectionRow.total_paisa) and :9615-9619 (DailyCollectionSummary.total_paisa) declare `minimum: 0`, so that response violates the contract. Reconciliation and the contract bound cannot both hold on such a day.

Proposed change (exact) — lead chooses ONE:
(a) Signed net (writer recommendation: smallest change, keeps done_when 4 reconciliation exact, no code change in the API):
    DailyCollectionRow.entry_count: `minimum: 0` -> `minimum: -2147483648`
    DailyCollectionRow.total_paisa: `minimum: 0` -> `minimum: -9007199254740991`
    DailyCollectionSummary.total_paisa: `minimum: 0` -> `minimum: -9007199254740991`
    descriptions: add "net of refunds and reversals booked on that day; can be negative when refunds exceed collections".
(b) Separate non-negative fields (additive): DailyCollectionRow gains required `refund_count` (integer, minimum 0) and `refund_paisa` (int64, minimum 0); entry_count / total_paisa become gross collections (minimum 0 stays); DailyCollectionSummary gains `refund_paisa` (minimum 0) and `net_paisa` (signed) so net_paisa reconciles with getDailyCash totals.net.amount_paisa + net account credits. API: split the UNION into gross and refund sums.

Backward compatible? (a) loosens a response bound — no consumer breaks (T0D-ACCT-2 screen not merged yet). (b) adds required response fields — breaking only for a consumer validating strictly; none exists yet.
Tenant/security impact: none. No RLS change, no new PHI field, no new surface; same permission and centre filter.
IRD/regulatory impact: none (lab accounting report only, LD-313 (e) no money moves; no invoice or CBMS change).
Alternatives considered:
- Clamp negatives to 0 or drop negative rows: rejected, breaks reconciliation with getDailyCash (done_when 4) and hides refunds.
- Count the refund on the original payment day: rejected, getDailyCash books by business_date of the refund row.
Tests that will prove it:
- dailySummary.test.ts refund-only day test (reads the bounds from billing.yaml, so it follows either option); for (b) the tester adds refund field assertions.
- dailySummary.test.ts reconciliation tests :84-93 unchanged and green.
- contracts registry / lint tests green after the yaml edit.
