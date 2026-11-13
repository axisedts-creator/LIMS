# T-B5 impl (writer)
- Files: api `service/reminder.service.ts` (scheduleBookingReminder, cancelBookingReminders), `repository/reminder.repo.ts`, `service/booking.service.ts` (enqueue `engagement.send_booking_message` bmsg:<id>:<kind> max 8 + reminder schedule/cancel); worker `jobs/engagement/tasks/send_booking_message.ts` + `index.ts` manifest entry.
- Templates/purposes per CR-C16-009 + 08 R13: confirmation -> engagement.booking_confirmation, cancelled -> engagement.booking_cancelled; params exactly {lab_name, datetime, booking_no}.
- [CONV] reminder only when slot - now > booking_reminder_hours_before (strict); missing settings row -> 24 (05-SCHEMA default).
- [CONV] booking messages not gated by reminders_enabled/opt-out; stale/hostile jobs silent no-op; unknown port status throws (retry).
- Tests after ruling: 54/54 pass (API 31, worker 23). Engagement API 1183 pass; 1 pre-existing unrelated fail `boot.test.ts` (PHASE_STUBS lacks QualityPort). Worker engagement 185 pass. tsc: no errors in touched files.
- Review fix: notification TTL 30 -> 180 days (TRD §4.9, 05-SCHEMA). Re-run: API 31/31, worker 23/23.
- Open: boot.test.ts QualityPort stub owned elsewhere; send_reminder.ts has the same 30-day TTL -> T-R1 owner.
