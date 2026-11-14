CHANGES

T-N1 lead ruling (LD-180, founder go 19:12): CR-C16-T-N1 option A is APPROVED. LD-180 binds; read it first.

Test files (tester):
1. services/api/src/modules/engagement/service/__tests__/enquiry.handlers.test.ts: the reply rows no longer expect an enquiry_reply row inserted by the staff transaction. They expect ONE enqueued job per reply inside the reply transaction, key notif:enquiry_reply:<enquiry_id>:<version>, payload {tenant_id, account_id, patient_id or null, kind 'enquiry_reply', entity_type 'enquiry', entity_id, entity_seq} and no text; a reply that fails or rolls back enqueues nothing. Keep the world rule: a direct staff INSERT into notifications is still refused (42501).
2. New worker test next to the other engagement job tests: exactly one notifications row per job; redelivery of the same job inserts none; a kind outside the allowlist is rejected; a payload tenant that differs from the job claims is rejected.

Implementation files (writer):
3. New generic worker task (name per the existing engagement jobs, see LD-180), registered like the others; allowlist only 'enquiry_reply'; INSERT ... ON CONFLICT ON CONSTRAINT notifications__dedupe__uq DO NOTHING; tenant scope from the job claims as the other engagement tasks do.
4. enquiry.service.ts: enqueue inside the reply transaction with the existing enqueue mechanism; remove the interim mapping of the refusal to common.internal.
5. If the existing mechanism cannot enqueue from the staff request transaction without a new grant, RLS policy, DB function or migration: stop and write a blocking CR (option B is the founder's call).
6. Write a non-blocking CR (Blocking? no) asking the founder to add the new task to 02-TRD 8.1; do not edit spec.
