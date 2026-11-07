TESTS_WRONG — fiscalYear.test.ts asserts two things the spec does not require; change the test, not fiscalYearOf.
1. Sweep (fiscalYear.test.ts:9-11, 46-55): spec/chunks/C4-frontdesk-billing/02-TRD.md:618 says fiscalYearOf "converts the instant to the tenant time zone date",
   i.e. real IANA Asia/Kathmandu rules. Those rules give +05:30 before 1986-01-01 (verified: Intl formats 1985-12-31T18:15Z as "23:45 GMT+5:30", 1986-01-01T18:15Z as "00:00 GMT+5:45").
   A fixed +05:45 `nptMidnight` therefore lands at 23:45 on the eve of Shrawan 1 for B.S. years before ~2043; the impl is right to return the previous FY.
   Fix: build `nptMidnight` from the zone, not a constant. Try offsets +05:45 and +05:30 and keep the one Intl (timeZone 'Asia/Kathmandu') formats as 00:00 local on `ad`.
   Keep the 2000..2099 range: spec/research/04-consolidated-decisions.md:54 (D13) requires the golden table to cover 2000–2099 B.S.
2. Regex test (fiscalYear.test.ts:57): '2090-12-31T12:00:00Z' is about B.S. 2147, outside the supported 1975–2099 B.S. range (04-consolidated-decisions.md:54, D13).
   The impl must throw common.date_out_of_range there (the test at :73 already requires this). Replace it with an in-range instant, e.g. '2042-12-31T12:00:00Z'.
Do not change the implementation.
