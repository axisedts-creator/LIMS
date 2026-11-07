# BL-T02 dispute (writer) — 2 tests in fiscalYear.test.ts are wrong; 240/242 pass
1. `sweep 2000..2099` (line 46-55): helper `nptMidnight` assumes a fixed +05:45 offset. IANA Asia/Kathmandu was +05:30 until 1986-01-01
   (`node -e` Intl: 1943-07-16T18:15Z -> "16/07/1943 23:45 GMT+5:30"). TRD §12 says convert to the tenant *time-zone date*, so for B.S. years
   before ~2042 the test instant is 23:45 on the eve of Shrawan 1 and the impl correctly returns the previous FY (first failure: Shrawan 1 2000 -> 1999/00).
   Fix: derive the local-midnight instant from the tz (e.g. try +05:45 and +05:30 and keep the one Intl formats as 00:00), or start the sweep at B.S. 2043.
2. `long always matches invoices__fy__ck` (line 57): `2090-12-31T12:00:00Z` is ~B.S. 2147, outside the supported 1975-2099 B.S. range (04 D13),
   so it throws `common.date_out_of_range` (as the test at line 73 requires). Fix: use an in-range instant, e.g. `2042-12-31T12:00:00Z`.
