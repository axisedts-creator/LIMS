APPROVE
Round 3 #1 is fixed per LD-74. `realStamp` (reports-read.handlers.ts:11-30) now works like this:
- A regex checks the shape.
- The instant is rebuilt with setUTCFullYear/setUTCHours, which avoids the Date.UTC 0-99 year remap, and every part is compared with the parsed parts.
- Year must be 1..9999, offset hours <= 23 and offset minutes <= 59.
- 24:00:00 is handled explicitly.
- The final instant must also fall in year 1..9999.

The same check guards the cursor `k` (lines 81 and 207) and all date filters (`stamp`, line 53).

I checked it in node against these inputs:
- Rejected: 0000-01-01, 2025-02-29, 2026-04-31, month 13, day 00, 24:00:01, hour 25, minute 60, second 60, +24:00, 9999-12-31T24:00Z.
- Accepted: 2024-02-29, 0001-01-01, 0050-06-01, 2026-12-31T24:00Z, 9999-12-31T23:59Z.

The tests add the round-3 cursors (year 0000, Feb 30, month 13, day 00), and the same four values on both registered_at_from and registered_at_to give 400. reports-read.handlers.test.ts: 124/124 pass.

No new defect. The diff touches only owned paths (handlers + tests) plus impl notes. It adds no new names, logging or SQL, and does not touch vitest.config.ts.
