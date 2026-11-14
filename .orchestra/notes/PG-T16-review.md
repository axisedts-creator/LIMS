APPROVE

Reviewed `git diff 2522daae..HEAD` (PG-T16) against 02-TRD §5 P17–P19, §6.8, `StaticQrReconDto` (l.227), 05-SCHEMA `payments.static_qr_reconciliations`, 01-PRD US-PG-12 AC2–3, 08 CR-C15-006/009, R4.

- Names verbatim: ops `listStaticQrReconciliations`/`previewStaticQrReconciliation`/`createStaticQrReconciliation`, view `billing.v_pub_payment_collection` with `payment_method_code` (R4), method `fonepay_qr`, error `payments.static_qr_already_reconciled`, statuses `matched`/`accepted_with_difference`, DTO fields match l.227.
- §6.8 query reproduced exactly (tenant + date + method [+ centre]); figures re-read at save (REQ-SEC-046); strict body allows only the TRD P19 fields; generated `difference_paisa` not inserted; status/note rule mirrors `static_qr__status__ck`.
- Tenant isolation: every query filters `tenant_id = $1` on top of RLS; composite FK 23503 mapped to `common.validation_failed(centre_id)`; dup -> 409 via `ON CONFLICT DO NOTHING` on the partial unique indexes (race-safe on real PG).
- No ledger write, no port call, no access-log row, no logging, no secrets; SQL parameterised (only interpolated literal is the constant `fonepay_qr`).
- Owned paths only (payments module + own notes); `reconciliation.service.ts` change is export-only.
- Permission (`payments.reconciliation.read` / `payments.intent.resolve`), Idempotency-Key and route wiring are pipeline/handler concerns, not in this task's file list.
- Tests: verify cmd run by reviewer — 2 files, 95/95 pass. Cover preview from seeded view rows, centre/method/date filtering, difference/note rule, 409, re-read at save, list paging.

Non-blocking notes: whitespace-only `statement_reference` is accepted (DB CHECK only needs length ≥1); `created_by`/`updated_by` use membershipId where reconciliation.service uses `actor.id` for `updated_by` — align if C0 defines which one audit columns take. Real-PG/RLS not exercised (fake DB), as stated in tester notes.
