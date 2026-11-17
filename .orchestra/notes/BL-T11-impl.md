# BL-T11 impl (writer)
Files: service/ledger.service.ts (+reverseEntry), service/refund.service.ts (new: B10/B10a/B10b/B10c/B36), repository/refundRequests.repo.ts (new), repository/ledger.repo.ts (+getLedgerEntry, findReversalOf, 7 insert columns), repository/index.ts, handlers/ledger.handlers.ts + index.ts (7 stubs replaced).
Review round 1: removed invented credit-order refusal in B10 (refundable cap alone applies); filed .orchestra/cr/BL-T11.md (gateway-method marker for B10 feature_disabled, B36 'refunded' rule, B36 default status).
Checks: billing module 1057 pass / 49 skipped / 0 fail (incl. new 8b/8c); tsc clean for billing. Real SQL/RLS/row-lock not run (fakes only).
[CONV] finance_review_items.resolved_by stores the resolver's MEMBERSHIP id; repo seam takes `membershipId` + `userId`.
[CONV] approve: status -> self-check -> If-Match before any write; 23505 on refund_request unique -> common.version_conflict; absent If-Match -> common.precondition_required.
[CONV] B9 refuses order-less originals with billing.ledger_reversal_invalid; P0001 reversal_mismatch maps to it.
Open (CR-BL-T11): B10 common.feature_disabled; B36 'refunded' w/o refund id allowed; B36 default status; B10 idempotency key not stored.
