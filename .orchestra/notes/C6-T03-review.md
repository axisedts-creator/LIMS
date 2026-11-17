APPROVE

Re-review after f9606f6 / 773740d. Both prior findings are fixed:
1. CR filed at `.orchestra/cr/C6-T03.md` as CR-C6-021 (next free id after CR-C6-020 in 08-CR-REGISTER). It uses the 04 template, offers options A (DDL) and B (derive). The `[CONV]` comment at settings.service.ts:106 cites the CR. The reject-until-resolved behaviour is kept.
2. `version()` (settings.service.ts:46-50) now rejects values above 2147483647 with `/If-Match`. This covers every caller (settings, centre contacts, and the rest). New tests cover S2 and S5 with 2147483648 -> `common.validation_failed` and no write.

The earlier "Checked OK" list still holds; the fix diff touches nothing else. Ran: reporting vitest 284/284 pass (5 files); `tsc --noEmit` clean.
Non-blocking (lead), carried over: done_when "integration CRUD under RLS" is still only covered by the in-memory fake tx, because there is no live-DB harness in services/api. AC-13.3 is partial by plan (C6-T18). CR-C6-021 needs a lead/C0 decision before C6-T18.
