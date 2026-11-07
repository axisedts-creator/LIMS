# BL-T11 impl (writer)
Files: service/ledger.service.ts (+reverseEntry), service/refund.service.ts (new: B10/B10a/B10b/B10c/B36), repository/refundRequests.repo.ts (new), repository/ledger.repo.ts (+getLedgerEntry, findReversalOf, 7 insert columns), repository/index.ts, handlers/ledger.handlers.ts + index.ts (7 stubs replaced).
Checks: BL-T11 suite 132/132 pass; whole billing module 1055 pass / 49 skipped / 0 fail; tsc clean for touched files (pre-existing unrelated tsc errors in contracts/ + shared-ts); no eslint installed in services/api. Real SQL/RLS/row-lock not run (fakes only).
[CONV] finance_review_items.resolved_by stores the resolver's MEMBERSHIP id (Actor DTO needs it); the fake stores the user id there, so B36-resolve builds its DTO from ctx. Repo seam takes `membershipId` + `userId`.
[CONV] approve: status -> self-check -> If-Match checks run before any write; 23505 on refund_request unique -> common.version_conflict; absent If-Match -> common.precondition_required.
[CONV] B9 refuses order-less originals (credit-party payments) with billing.ledger_reversal_invalid until their reversal is specified; P0001 reversal_mismatch also maps to it.
Open: B10 `common.feature_disabled` (no field names a gateway method) and B10 idempotency (no stored key) not implemented; B36 'refunded' without refund id allowed; refunds use captureKind 'manual' only.
