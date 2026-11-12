APPROVE

Round 3. Round-2 item 1 FIXED (0718fb4b): reminder.repo.ts:33-36 `listReminders` binds `tenant_id = $1` (REQ-SEC-024); reminder.service.ts:74,88 passes `tenantId` from `scope(ctx)`; [CONV] lines removed. Re-ran: api reminder.handlers 15/15, worker reminders 29/29.

Observations (not blocking, carried):
- packages/fakes/src/NotificationPort.fake.ts is C0-0C-owned; orchestrator to confirm this lane may add the CR-C16-009 templates.
- [CONV] failure codes `reminders_disabled`/`opted_out`/`booking_inactive`/`booking_not_found` and "feature off -> no in-app rows" stay on the chunk CONV log.
- Not verified: no real-DB/RLS run (no C0 DDL); lint not run. If a real NotificationPort writes in the same tx and fails with a SQL error, the aborted tx makes the `finish('failed')` UPDATE fail too (job dead-letters, row stays scheduled). Recheck when the real adapter lands.
