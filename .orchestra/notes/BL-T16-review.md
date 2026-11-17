APPROVE
BL-T16 review (ed295071..HEAD). Ran `npx vitest run services/worker/src/jobs/billing/__tests__/consumers.test.ts`: 23/23 pass.
- Names verbatim: `payments.intent.settled.v1`, `homecollection.collection.synced.v1`, kinds `home_payment_exceeds_due` / `home_payment_method_inactive` (02-TRD §8 consumer table + work-item note); `payment_method_code` per 03-IC §3.23.
- done_when: idempotent (ledger key = client_mutation_id; duplicates skip item insert; gateway replay = no-op); overpayment item (home path here, gateway path via BillingPort allowExceedsDue); inactive/unknown method = recorded (ledger.service.ts:113-118 skips method check for home_collection) + item, never throws; booking_id/unknown fields never read.
- Tenant from ctx only; mismatched envelope writes nothing. Log line carries no PHI. No secrets. Paths owned (services/worker/src/jobs/billing). No new tables/RLS in scope.
- Non-blocking: C0 wrapper must supply ctx.ports/actor (writer note); retry policy for idempotency_key_reused left to wrapper (spec silent).
