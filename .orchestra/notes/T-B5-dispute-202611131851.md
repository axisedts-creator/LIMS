# T-B5 dispute (writer)
Test: `services/worker/src/jobs/engagement/__tests__/send_booking_message.test.ts:117-123` ("payload tenant_id different ... unknown kind, missing keys: resolve quietly, nothing sent").
Problem: helper `run = (bookingId, kind: unknown = 'confirmation', ...)` has a default parameter. The table row `[b['id'], undefined]` ("missing kind") calls `run(id, undefined)`, so JS substitutes `'confirmation'`. The job becomes a valid confirmation for a live booking, and the task correctly sends one SMS. The assertion `w.notif.calls toEqual([])` then fails (1 call: bmsg:<id>:confirmation).
Not an implementation bug: a valid confirmation for a confirmed booking MUST send (US-EN-12.8; same file, test 1). The task already no-ops on kind absent / unknown / 'CONFIRMATION' / 'refund' when they reach it.
Fix (tester): make `kind` reach the payload as undefined, e.g. `run = (bookingId, ...args)` / `arguments.length`, or pass `payload: { kind: undefined }` for that row.
State: 54 tests — 53 pass, this 1 fails. All other engagement tests unchanged (API 1183 pass; unrelated pre-existing fail: `boot.test.ts` PHASE_STUBS lists no QualityPort).
Impl is complete: `reminder.service.ts` (+`reminder.repo.ts`), `booking.service.ts` wiring, `tasks/send_booking_message.ts`, manifest entry.
