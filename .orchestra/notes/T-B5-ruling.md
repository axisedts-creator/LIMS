TESTS_WRONG — the "missing kind" row never sends a missing kind; the helper's default parameter turns it into a valid confirmation, which the spec requires to send.
Reasons:
- services/worker/src/jobs/engagement/__tests__/send_booking_message.test.ts:30 declares `kind: unknown = 'confirmation'`. In JS, passing `undefined` triggers the default, so row `[b['id'], undefined]` at :120 runs `{kind:'confirmation'}` for a live confirmed booking.
- spec/chunks/C16-patient-engagement/01-PRD.md:241 (US-EN-12.8): a successful booking MUST get a `booking_confirmation` SMS through NotificationPort. 02-TRD.md:333 (§4.8 step 7) enqueues `{booking_id, kind:'confirmation'}`. 02-TRD.md:661 (§8.1) sets key `bmsg:<booking_id>:<kind>`. So one send (bmsg:<id>:confirmation) is correct behaviour, and the test's own first case (:46-53) asserts the same thing.
- The no-op for a truly missing kind is ASSUMED in the test header (:14), not required by the spec. It stays as a tester assumption, but the test has to really exercise it.
Change in the test (keep every other row and assertion as is):
- Make the "missing kind" row reach the task with no `kind`. For example, drop the default (`kind?: unknown`, and have the caller pass 'confirmation' where needed), or replace the row with `w.runTask(task, { tenant_id: TENANT_A, booking_id: b['id'] }, {})` / a payload whose kind is explicitly `undefined`, without going through the default.
- Keep `expect(w.notif.calls).toEqual([])` and `expect(w.writes()).toEqual([])` at :123.
