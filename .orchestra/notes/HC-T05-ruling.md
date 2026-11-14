TESTS_WRONG — booking.consumers.live.test.ts:367 compares a pg `Date` with a seeded `YYYY-MM-DD` string via `String(x).slice(0,10)`; the spec requires no such string form.
Reasons:
- spec/chunks/C17-home-collection/01-PRD.md:177 (US-10-2) requires only: status `cancelled` + flag `order_cancel_required` linking to `staff.frontdesk.order`. It says nothing about the textual form of `route_date`; keeping route fields is the test's own (reasonable) assumption and stays.
- Line 367 fails for any implementation: `String(Date)` yields "Sat Jan 02…", the seed yields "2027-01-02". The consumer does not write `route_date`, so no implementation change can make it pass.
- Fix in the test, line 367: normalise both sides to a date-only string without a timezone shift. pg parses DATE as LOCAL midnight, so `toISOString()` can roll the day back east of UTC. Use a helper such as
  `const ymd = (d: unknown) => d instanceof Date ? \`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}\` : String(d).slice(0,10);`
  then `expect(ymd(v.route_date)).toBe(ymd(visit.route_date));`. Selecting `route_date::text` in the read also works.
- No other assertion in this test changes. The implementation does not change.
