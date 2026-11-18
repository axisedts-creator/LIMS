# T0D-UILIST-2 dispute (writer) — 5 of 63 uilist2 tests contradict each other or an older pinned test

Run: verify.cmd uilist2 config = 58/63 green, web-style-3 101/101. The 5 reds cannot be made green by any markup.

1. Exact header string vs "currency in the header" (same file, same screen). `expectTable(..., { headers: [string] })` (uilist1.helpers:61) compares the WHOLE header text case-insensitively, while `expectMoneyColumn` (uilist2.helpers:37) requires NPR inside that same header text. One header cannot be both "Credited" and contain "NPR".
   - uilist2.accounts:101 entries `['Entry Date','Credited','Debited']` vs :112-113 `/^Credited\b/` + NPR. Page draws "Credited (NPR)".
   - uilist2.accounts:189 summary `['Client Name','Credit Limit','Outstanding Amount','Is Blocked']` vs :200-201 + NPR. Page draws "Credit Limit (NPR)", "Outstanding Amount (NPR)".
   - uilist2.payments:108/115 static-qr HEADS `'System','Statement','Difference'` vs :125 + NPR. Page draws "System (NPR)" etc.
   Fix asked: make the money names regexes (`/^Credited\b/i`, ...), as uilist2.lists already does for its money columns.
2. Discount approvals money (uilist2.lists:117-118) vs fd-t14.screens:285-288 (still pinned, not updated by the tester): fd-t14 wants header exactly "Gross"/"Discount" and cells "NPR 1,500.00" / "NPR 450.00"; uilist2 wants NPR in the header and bare "1,500.00" cells; uilist2.lists:108 also pins exact 'Gross'. Fix asked: update fd-t14:285-288 and uilist2.lists:108 per rule 3 (as done for acct1 / bl-t20 / rs-c15.behaviour); then the writer splits Discount into "Discount (NPR)" + a percent column.
3. uilist2.payments:74 `findByText('Missed settlement')` is ambiguous: the required FilterBar's Kind multi-select (kit FilterBar MultiSelect, packages/ui) draws every finding kind as a chip, so the text is in the chip AND the cell. Fix asked: `findAllByText` or `within(table)`.
4. Old pg-t19 pins not updated by the tester, now contradicting done_when 5 / rule 6 (6 reds, pg-t19 218/224):
   - pg-t19.recon + pg-t19.staticqr "API 5xx rejects so error.tsx renders": rule 6 says 500 keeps title + filters with an ErrorState (uilist2.payments 500 tests pin that). Fix asked: assert the ErrorState.
   - pg-t19.staticqr form tests `getByRole('button', { name: /centre/i })`: the required list FilterBar has its own Centre select, so two matches (the "5 previews" red is fallout of the same test leaking; it passes alone). Fix asked: scope to the form (`within(form)`).
Writer stopped on these; no test file touched.
