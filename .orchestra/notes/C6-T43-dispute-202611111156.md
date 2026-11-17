# C6-T43 dispute (writer)
Test: services/worker/src/jobs/reporting/__tests__/release_dues_link.test.ts, "balance paid -> the same task releases the version ... revokes every unrevoked dues link with dues_settled" (l.122, l.127).
Defect: the test does `w.portalLinks().push(linkRow(7, { purpose: 'report', delivery_id: null }))`. `portalLinks()` = `s.db.all('reporting.portal_links')` (delivery.helpers.ts l.310, consumers.helpers.ts l.261: `rowsOf(t).map((r) => ({ ...r }))`) returns COPIES, so the push never reaches the store. l.127 then does `.find(purpose === 'report')!` on a store that has no report link -> `TypeError: Cannot read properties of undefined (reading 'revoked_at')`.
Not an implementation bug: rule 8 + release + revoke all ran (dues link revoked `dues_settled`, version `released`, `paid_in_full`; l.124-126 pass).
Fix (tester): seed through the store (`w.db.store['reporting.portal_links']!.push(...)`) or via a world option before the first run.
Impact: 1 of 19 tests in the file; the other 18 pass.
