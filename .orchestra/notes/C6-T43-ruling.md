TESTS_WRONG — release_dues_link.test.ts l.122 seeds the report link into a copy, not the store, so l.127 can never find it.
Reasons:
- delivery.helpers.ts:309,314 `portalLinks()` = `s.db.all('reporting.portal_links')`; consumers.helpers.ts:261 `all = rowsOf(t).map((r) => ({ ...r }))` returns fresh copies, so `.push()` on it never reaches the fake DB (t39.a4.escape.test.ts:12 already documents "db.all() returns copies").
- l.127 `.find(purpose === 'report')!` therefore yields undefined -> TypeError; this is a fixture defect, not a spec assertion failing.
- Spec intent the line protects (rule 8 revokes only unrevoked dues links with dues_settled; report links untouched — 02-TRD §4.6 rule 8, 08 A21.1, AC-18.10) is valid and must stay asserted.
- Writer reports l.124-126 pass (version released / paid_in_full, dues link revoked dues_settled), so implementation behaviour on the observable spec points is not in question.
Change in the test (tester): replace l.122 with a store write, e.g.
  `(w.db.store['reporting.portal_links'] ??= []).push(linkRow(7, { purpose: 'report', delivery_id: null }));`
(or seed it via the deliveryWorld options before the first run). Keep l.125-127 assertions unchanged.
