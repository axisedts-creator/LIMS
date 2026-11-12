CHANGES

Round 2. Item 1 (terminal `failed` path) FIXED: send_reminder.ts:74-93 + 2 worker tests (8/8 → failed, no re-enqueue). Re-ran: api reminder.handlers 15/15, worker reminders 29/29.

1. services/api/src/modules/engagement/repository/reminder.repo.ts:33-40 — round-1 item 2 still open: `listReminders` does not bind `tenant_id` (REQ-SEC-024, 07-SECURITY). The tester already fixed the fake (reminders.world.ts:98-103 now matches only `id = $n` / `patient_id = $n` and the keyset cursor), so the stated reason for the [CONV] is gone. Fix: add `tenantId: string` to the args; start with `const v: unknown[] = [a.tenantId, a.from, a.to]; let where = 'tenant_id = $1 AND due_at BETWEEN $2 AND $3';` (the push-based `$${v.length}` refs then stay correct). In reminder.service.ts:74 use `const { tx, tenantId } = scope(ctx);` and pass `tenantId` at :88. Delete the [CONV] lines at reminder.repo.ts:2 and reminder.service.ts:3 (keep the REQ-SEC-024 note as "all statements bind tenant_id"). Re-run reminder.handlers.test.ts (isolation cases must still pass).

Observations (not blocking, carried from round 1):
- packages/fakes/src/NotificationPort.fake.ts is C0-0C-owned; orchestrator to confirm this lane may add the CR-C16-009 templates.
- [CONV] failure codes `reminders_disabled`/`opted_out`/`booking_inactive`/`booking_not_found` and "feature off → no in-app rows" stay on the chunk CONV log.
- Not verified: no real-DB/RLS run (no C0 DDL); if a real NotificationPort ever writes in the same tx and fails with a SQL error, the tx is aborted and the `finish('failed')` UPDATE would fail too (job dead-letters, row stays scheduled). Fine with the current fake; recheck when the real adapter lands.
