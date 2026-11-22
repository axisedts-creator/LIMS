APPROVE
# T0D-BUILD-3 review (reviewer), diff 7d586e15e..ed491f1cd

Ran: build3 + fix2 api 59/59 pass; t20 build3-access-review + audit-sessions web 78/78 pass. I did not re-run the full identity, webfix1 or admin suites; the writer's notes say the failures there were already present.

Checked line by line (LD-189):
- Names match identity.yaml:3513-3551 / 6326-6351 exactly: listAccessReviews (identity.user.read, x-idempotency none), recordAccessReview (identity.user.manage, x-idempotency required, x-error-codes [common.idempotency_key_reused]). AccessReviewList has no paging in the contract: only data with maxItems 200. The service uses LIMIT 200, newest first (reviewed_at DESC, id DESC).
- Permission check comes first: handlers/accessReview.ts wraps both operations in guarded(), and _guard.ts calls assertRole before the handler and fails closed when the port is missing.
- Tenant: tenant_id comes from ctx in every SQL statement. The table already exists (migration :594). RLS is ENABLE + FORCE (:687-688) with select and insert policies (:761, :763). No migration was added and the contract was not edited.
- Reviewer = ctx.actor.membershipId (403 if missing) and created_by = actor.id, never taken from the body. reviewed_at = now(). The body is checked against AccessReviewCreateRequest: integer 0..100000, notes up to 2000 code points (same as char_length), additionalProperties false. Errors are typed 4xx.
- Idempotency is handled by the core hook. The tests exercise the real hook around the real handler: replay and key reuse with another body both pass.
- Audit: the row trigger access_reviews__audit (migration :958) writes it in the same transaction, as the ruling in T0D-BUILD-3-ruling.md requires. Notes text does not appear in any log or error detail.
- Web: the NotAvailable page is gone. The reviews Grid shows Date, Reviewer, Memberships reviewed and Notes. The Record dialog (kit) has the count prefilled with active memberships and a notes field. The button is hidden without identity.user.manage. There are a success toast, empty and loading states, and one request per double click. recordAccessReview in actions.ts sends idempotent: true.
- No secrets or PHI; test data is synthetic. 11 source and test files changed (limit is 12), all on the paths in the brief.

Non-blocking (not defects):
- Errors show as an in-dialog Alert with the request id, not a toast. The dialog keeps the typed values open, and the tests accept this.
- Grid is the existing admin native table drawn with kit DataTable classes (pre-existing [CONV] in Grid.tsx:4), not the DataTable component.
