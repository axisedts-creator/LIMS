# PG-T14 impl (writer)
- Files: `service/refund.service.ts` (new: createRefundService P6-P10 + port refund()), `ports/PaymentProviderPort.impl.ts` (refund = real, replaces PG-T01 stub). No test files touched.
- Run: refund.service + helpers 156/156 green; full payments suite 1552 pass, only the pre-existing manifest PHASE_STUBS test fails; tsc clean for these files.
- [CONV] key already spent (status requested/held_for_review/completed/failed): body mismatch -> 422 idempotency_key_reused, match -> replayed:true with the stored status (tests pin only `requested`). Key on a pending/approved row -> approval path (403 refund_requires_approval on any mismatch).
- [CONV] in-flight uniqueness = INSERT ... ON CONFLICT DO NOTHING on the partial unique index (0 rows -> 409 refund_not_allowed); api-mode execute_refund job key `execute_refund:<id>` enqueued in P9 only.
- [CONV] coded-set lookup (g_cs_reasons + tenant cs_reasons override) is duplicated from handlers/intents.ts (PG-T12 file, not mine); fold into shared.ts if a later task owns it.
- Open: PaymentProviderPort.real.contract cases 8/9/18 are still `t.skip()` (tester file, "refund cases: PG-T14") - tester should unskip. Handlers/mapping to RefundDto (toRefundDto) not wired (service returns stored rows). Row-audit trigger, real-DB concurrency untested (no C0 DDL).
