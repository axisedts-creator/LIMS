APPROVE

# PG-T14 review (reviewer) — diff b2909555..7ed32ea0

Checked against TRD §6.6 steps 1-3, PRD US-PG-09 AC1/2/3/6/8, plan row PG-T14, 05-SCHEMA §6 refunds, 02-CV P-40.
- Names verbatim: error codes (payments.refund_not_allowed / refund_exceeds_captured + detail "exceeds refundable balance" / refund_self_approval_forbidden / refund_requires_approval, common.idempotency_key_reused / validation_failed), permissions (payments.refund.request / .approve / reconciliation.read), task payments.execute_refund, constraint names refunds__*__ck / __uq, key 'refund:' || id.
- Two-person rule (membership compare, default threshold 0, tenant-scoped settings), bounds at request and re-checked at approve, in-flight uniqueness via partial unique index (ON CONFLICT DO NOTHING -> 409), intent row locked FOR UPDATE.
- Port refund(): P-40 grammar validated before any refunds read; spent-key replay / reuse; approval must match intent, amount, reason, key; no existence oracle; same-tx rollback on approve failure (tested).
- Tenant isolation: every query has tenant_id = $n; other-tenant ids -> 404. Centre scope via assertRole -> 404 (ST-18). Actor guard (patient/portal/device -> 403). No ctx.audit / access-log row (D-112). No PHI/secrets in logs. SQL column names are code constants only (no injection). Only owned paths touched.
- Ran `.orchestra\notes\PG-T14-verify.cmd`: 6 files, 156/156 pass.

Non-blocking gaps (not defects of this task):
- Plan "tests" column asks for row-audit rows on request/approve/reject (D-112); not testable until the C0 payments DDL + row-audit trigger exist. Re-check when the migration lands.
- PaymentProviderPort.real.contract refund cases 8/9/18 still t.skip() — tester to unskip.
- Real-DB concurrency of the partial unique index unproven (fake serialises transactions).
