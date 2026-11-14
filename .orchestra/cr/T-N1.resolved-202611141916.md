Title: CR-C16-T-N1: system-actor path for the N3 `enquiry_reply` in-app notification
From chunk: C16            To owner: C16 (02-TRD §4.9 / §8.1 task list, 05-SCHEMA §5.2)
Type: schema | event (task)
Blocking? yes — T-N1 (N3 `replyEnquiry`, US-EN-18.2): every staff reply fails; 8 tests in services/api/src/modules/engagement/service/__tests__/enquiry.handlers.test.ts red.
Problem: 02-TRD §4.9 (line 357) requires an `enquiry_reply` notification on staff reply, and says rows "are created by the system actor" (line 347). 05-SCHEMA §5.2 RLS table (line 1347) grants `engagement.notifications` INSERT to SYS only. N3 runs in the staff request transaction (user claims), so the INSERT hits RLS WITH CHECK (42501). The spec names no task, event or DEFINER through which N3 can create the row: 02-TRD §8.1 has no notification task and there is no enquiry event. Other kinds come from events/tasks (report_ready, sample_recollection, reminders); `booking_confirmed`/`booking_cancelled` ("any actor") have the same gap.
Proposed change (exact) — owner picks the name; options:
  A) New §8.1 task (name to be assigned by owner, e.g. a generic notification-create task) enqueued in the N3 transaction with payload `{tenant_id, account_id, patient_id, kind:'enquiry_reply', entity_type:'enquiry', entity_id, entity_seq}`, run by the worker as the engagement system actor; idempotency key per reply, e.g. `notif:enquiry_reply:<enquiry_id>:<version>`; INSERT … ON CONFLICT ON CONSTRAINT notifications__dedupe__uq DO NOTHING.
  B) SECURITY DEFINER `app.engagement_create_notification(...)` (05-SCHEMA §6 table), EXECUTE to lims_app, tenant from `app.current_tenant_id()`, kind restricted to request-triggered kinds (`enquiry_reply`, `booking_confirmed`, `booking_cancelled`).
  A keeps the reply and notification in one transaction (outbox semantics) and matches "created by the system actor"; preferred.
Backward compatible? yes — additive task/function; RLS unchanged.
Tenant/security impact: no RLS change; no text/PHI in payload (ids, kind, seq only — 07-SECURITY §3); tenant fixed by job claims / session GUC, never a caller parameter.
IRD/regulatory impact: none.
Alternatives considered: grant staff INSERT on notifications (rejected: widens RLS against 05-SCHEMA line 1347); skip the notification (rejected: breaks US-EN-18.2 / 02-TRD §4.9).
Tests that will prove it: enquiry.handlers.test.ts N3 rows (one `enquiry_reply` row per reply, own account, patient_id or null, no text) with world INSERT SYS-only; for A: job enqueued in the reply tx with the per-reply key, worker test inserts exactly one row and redelivery inserts none.
Interim (writer): N3 maps the refusal to `common.internal` (not 404) — services/api/src/modules/engagement/service/enquiry.service.ts.
