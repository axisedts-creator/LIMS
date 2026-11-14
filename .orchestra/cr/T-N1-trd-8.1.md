Title: CR-C16-T-N1b: add engagement.create_notification to 02-TRD §8.1 (LD-180 rule 6)
From chunk: C16            To owner: C16 spec (founder text)
Type: api (worker task table row; no DDL, no grant, no RLS, no DB function)
Blocking? no  (T-N1 is implemented; the task runs with the queue default max_attempts until the row exists)
Problem (what you cannot do today, with the user story / acceptance criterion it serves): US-EN-18.2 staff reply notifies the patient in-app. Per LD-180 (CR-C16-T-N1 option A) the API enqueues a generic worker task that writes engagement.notifications as the system actor; 02-TRD §8.1 has no row for it.
Proposed change (exact): 02-TRD §8.1 new row —
  task `engagement.create_notification`; producer: N3 replyEnquiry (inside the reply tx, `SELECT app.enqueue_job($1, $2::jsonb, $3)`);
  payload `{tenant_id, account_id, patient_id (uuid|null), kind, entity_type, entity_id, entity_seq}` (no text, no PHI; kind allowlist = `enquiry_reply` only, entity_type `enquiry`);
  job_key `notif:enquiry_reply:<enquiry_id>:<version>` (version = new enquiry version = entity_seq); effect: INSERT engagement.notifications ... ON CONFLICT ON CONSTRAINT notifications__dedupe__uq DO NOTHING;
  max_attempts: founder to choose (code uses the queue default; suggest 8 like send_booking_message).
Backward compatible? yes
Tenant/security impact: none new. Tenant from job claims; payload tenant mismatch rejected; strict payload shape; no payload values logged (07-SECURITY §3).
IRD/regulatory impact (billing changes only): n/a
Alternatives considered: option B (DEFINER function) rejected by LD-180.
Tests that will prove it: services/worker/src/jobs/engagement/__tests__/enquiry_notification.test.ts; services/api/src/modules/engagement/service/__tests__/enquiry.handlers.test.ts (N3 rows).
