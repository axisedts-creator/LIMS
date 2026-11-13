# T-Q5 dispute (writer) — packages/ui/src/components/__tests__/queueboard.test.tsx:75-79
- The test "stale shows the last-update time derived from staleSince" expects `/\d{1,2}:05/` for staleSince `2026-11-13T09:05:00Z`. That only holds if times are shown in UTC or in a zone with a whole-hour offset.
- Kit rule: every kit time is shown in the tenant zone `DEFAULT_TZ = 'Asia/Kathmandu'` (CV §4.8; `_shared/dates.ts:20`, used the same way by TokenSlip, DateText and DateTimePicker). 09:05Z is 14:50 in that zone (UTC+05:45). QueueBoard prints "Connection lost — showing last update at 02:50 PM", so the test fails.
- The machine's local time (the old page `toLocaleTimeString`) would also give 14:50 on this machine, so changing the zone would only make the test depend on the machine.
- Proposed test fix: expect `/02:50/` (tenant zone), or choose staleSince `2026-11-13T09:15:00Z` (= 15:00 NPT) and expect `/3:00|15:00/`. The other 9 QueueBoard tests pass.
