# T0B-FINCTRL-1 dispute 2 (writer) — new fiscalYear.test.ts pollutes the shared tenant A centre, flakes the unchanged T0B-ACCT-2 dailySummary pin
Run 3 after the ruling (`bash tests/billing/T0B-FINCTRL-1.pg.sh`, throwaway PG17, log .orchestra/notes/T0B-FINCTRL-1-run3.log): 753 passed, 1 failed. The three ruled pins now pass.
Failure: `billing/__tests__/accounts/dailySummary.test.ts:135` "same day, another centre's payments are not mixed in" -> expected 11000, received 161000 (diff 150 000 = default entryBody amount, accounts/helpers.ts:104, credit + cash).
Cause (test data, not service code): `finctrl/fiscalYear.test.ts:53` posts `entry(w, { entry_date: addDays(shrawan1(2083), -30) })` = 2026-06-17 (bsToAd(2083-04-01) = 2026-07-17), a 150 000 cash credit in world('a') = the same tenant + centre;
dailySummary.test.ts:127 picks a random day 2026-06-10..24 for that centre, so it fails whenever it draws 17 (1/15 per run). The 60 random dates of fiscalYear.test.ts:44 (2024-01-01..2026-11-16, same defaults) can also hit the private random days of dailySummary.test.ts:21 (2026-03-10..24) and :127.
run2 was green only by luck; three green runs in a row (done_when 8) cannot be guaranteed.
Proposal (tests only, no assertion loosened): in fiscalYear.test.ts post its entries as `entry_type: 'debit'` (the label does not depend on the type; daily summary counts credits only), or give them `payment_mode`-free debit / a private centre. Leave dailySummary.test.ts unchanged (existing ACCT-2 suite must stay unchanged).
No test file was edited by the writer.
