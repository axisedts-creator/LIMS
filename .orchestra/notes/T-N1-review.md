APPROVE

T-N1 2nd pass (LD-180 option A). Reviewed 791880d3..HEAD. Re-ran: API enquiries world + handlers 82/82, worker enquiry_notification 9/9.

Checked, no defect:
- LD-180 r1: generic task `engagement.create_notification` (tasks/create_notification.ts, registered in jobs/engagement/index.ts like the others); payload exactly {tenant_id, account_id, patient_id|null, kind, entity_type, entity_id, entity_seq}; no text/PHI.
- r2: kind allowlist {enquiry_reply -> enquiry} only; strict key-set + uuid/int validation; runs as module system actor via consumer.ts plain-task tx (per_tenant default, tenant claims from tenantOf(payload) as every engagement task); payload tenant must equal ctx.tenantId; INSERT bound, ON CONFLICT ON CONSTRAINT notifications__dedupe__uq DO NOTHING (constraint exists 05-SCHEMA:870); bad payload logs reason only.
- r3: replyEnquiry enqueues in the reply tx after message insert + status update via existing `SELECT app.enqueue_job($1,$2::jsonb,$3)` (same as analytics/billing/anatomic); key notif:enquiry_reply:<id>:<new version>. app.enqueue_job is SECURITY DEFINER already granted to lims_app and enforces registry + tenant match; registry-sync picks the task up from the manifest at deploy. No new grant, RLS policy, DB function or migration.
- r4: INSERT and its interim refusal mapping removed. Remaining `.catch -> common.internal` wraps the enqueue only (fail closed, not 404, not swallowed) — documented [CONV], acceptable.
- r5: tests assert job key/ids/kind, no text, ordering inside tx, failed/closed/probe replies enqueue nothing, staff INSERT into notifications still 42501; worker test covers one row per job, redelivery no-op, kind allowlist, tenant mismatch both ways, strict shape, no payload in logs.
- r6: non-blocking CR `.orchestra/cr/T-N1-trd-8.1.md` (Blocking? no), spec untouched.
- Only C16-owned paths + own notes/cr; no secrets; synthetic data only.
