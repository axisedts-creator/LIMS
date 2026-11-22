TESTS_WRONG — misReportPage.handler.test.ts:155-161 ("each served page writes its own entry (page 2 too)") cannot pass for the tds case with the current fixture; the fixture, not the requirement, is wrong.
Reasons:
1. spec/program/02-CONVENTIONS.md:357 — "end of data | `page.next_cursor` omitted". A one-row result at limit 1 is the last page, so no cursor is allowed.
2. The test file's own pins agree: line 8 ("next_cursor? (absent or null on the last page)") and fakeRun line 73 (cursor only when `after + limit < rows.length`).
3. FACTS (lines 38-49) holds exactly ONE tds row (line 48) on 2026-11-17, so `expect(p1.next_cursor).toBeTruthy()` (line 158) fails for tds; two_level_commission has 2 rows and passes.
4. The requirement under test (one referral_report.view entry per served page, A39/LD-342, brief item (1)) is valid and must stay for BOTH money codes; do not drop the tds case.
CHANGE (tester): add a second synthetic tds fact for tenant TA, day 2026-11-17, centre A1, ord 2 (e.g. party p2 'Synthetic Party Two', commission_payable_paisa 30_000, tds_bp 1_500, tds_withheld_paisa 4_500, net_payable_paisa 25_500). Then re-check every expectation that counts or sums tds rows (row counts, totals) and update only those numbers to match the new fixture.
The implementation needs no change for this point.
