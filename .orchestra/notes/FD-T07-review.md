APPROVE
Re-review after ae035d29 (review fixes). Prior finding 1 resolved: `.orchestra/cr/FD-T07-approval-gaps.md` files CR-C4-FD-T07-001 (F15 gross / absolute-max 422) and CR-C4-FD-T07-002 (draft_hash normalisation) in the 04-CHANGE-REQUESTS §2 template fields; both are cited at discount.service.ts:6 and :219. Fix is comment-only, no behaviour change.

Still OK from the first pass: names verbatim (F15-F19 operationIds, permissions, error codes, `frontdesk.discount_approval_expire`, cron `*/5 * * * *`, per_tenant, 3 attempts). Explicit tenant_id plus the worker tenant guard. `::uuid[]` cast. Self-approval is refused before the decision, with the DB CHECK as backstop. aal1 -> auth.mfa_required. Consumption is bound to base_fingerprint/patient/centre/discounts under FOR UPDATE, single use, in the same tx. No PHI or secrets in logs. Owned paths only. LD-70 n/a (no pending.json).
Ran: tests/frontdesk/FD-T07.pg.sh -> api 72/72, worker 13/13.
Open (tracked in the CR, not defects): new-patient approvals are refused until -002 is decided; F15 does not raise the 422 until -001 is decided.
