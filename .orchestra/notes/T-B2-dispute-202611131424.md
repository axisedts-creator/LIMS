# T-B2 dispute (writer) — 1 of 118 API tests cannot pass against any correct implementation
Test: `slot.handlers.test.ts` > S6 > "kind filter: home_collection 07-11 in 30-minute slots = 8 slots of capacity 2 ..." (line 428).
Claim: `hc.find(x => x.slot_start === S('01:30'))` toMatchObject `{booked: 1, remaining: 1}`.
Why wrong: T2 (home_collection) is 07:00-11:00 NPT (UTC+05:45), slot_minutes 30 -> slots start 01:15Z, 01:45Z, 02:15Z ... (07:00 NPT = 01:15Z, the same fact the T1 assertions on lines 407-409 rely on). No slot starts at 01:30Z (= 07:15 NPT), so `find` returns undefined.
Fixture cause: occupancy `O_H` (line 87) is at `S('01:30')` with `slot_end: S('02:00')`; it is off the template grid. An on-grid row would be `S('01:15')`..`S('01:45')`.
Evidence: the other 117 tests pass (hc length 8, capacity 2, kind filter, no T_OFF slots all pass before line 428).
Proposed fix (tester): put O_H at `S('01:15')` (slot_end `S('01:45')`), bk(8) slot_start/slot_end likewise, and assert `x.slot_start === S('01:15')` at line 428. The S10 T2 `affected.future_bookings: 1` and the S11 all-kinds count (4) do not depend on the slot time, but S11 range [01:30Z, 02:00Z) would then no longer overlap bk(8) (01:15-01:45 still overlaps, so 4 holds).
Writer stopped on this test; implementation is otherwise complete.
