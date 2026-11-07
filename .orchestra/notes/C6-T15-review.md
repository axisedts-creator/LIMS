CHANGES
Round 2 #1 is fixed: `realStamp` (Date.parse plus a day-in-month check) guards both the cursor `k` and the date filters. The 99-99 cursor test asserts 400 with no query issued. Verify cmd + settings test: 282/282 pass. Checked in node: V8 returns NaN for hour 25, minute 60, second 60 and offset +99:99, so those inputs are already rejected. 24:00 is accepted, and PG accepts it too.

1. `services/api/src/modules/reporting/handlers/reports-read.handlers.ts:13`: `realStamp` accepts year `0000`. `Date.parse('0000-01-01T00:00Z')` = -62167219200000, not NaN. PG rejects year 0 with 22008 "date/time field value out of range". So a tampered cursor `{"k":"0000-01-01T00:00Z",...}` or `registered_at_from=0000-01-01T00:00Z` still gets a 500, not 400. This is the same class as round 2 #1.
   Fix: in `realStamp`, add `y >= 1 &&` before `m >= 1`. In `reports-read.handlers.test.ts`, add two cursors to the malformed-cursor loop: `{k:'0000-01-01T00:00Z',...}` and `{k:'2026-02-30T00:00Z',...}`. The Feb-30 case is the one the impl notes call untested. Also add `['registered_at_from','2026-02-30T00:00Z']` to the 400 `it.each`.

Checked, no new defect: the round-2 diff touches only owned paths (handlers + tests). It adds no new names, logging or SQL text.
