TESTS_WRONG — the two "audit (LD-189)" cases demand a `ctx.audit.access` call that the spec does not give recordAccessReview.
Reasons:
1. spec/chunks/C2-identity-admin/02-TRD.md:506-525 is the closed list of every `ctx.audit.access` call C2 makes ("Every ... call C2 makes"); recordAccessReview is not on it, so no access-log action code is specified for it.
2. The listed codes (role.change, settings.change, ...) each name a different event; using one for a review record would misuse a seeded code, and a new code is not needed (CLAUDE.md: never invent a name).
3. recordAccessReview's row (02-TRD.md:279) asks only permission, body limits, 201, Idempotency required; no access_log write (contrast 02-TRD.md:269 and :275, which name theirs explicitly).
4. The brief's "writes an audit entry" is met by the row-audit trigger on the table: db/migrations/20261105001300_identity__create_identity_schema.sql:958 (`access_reviews__audit` ... `app.tg_row_audit()`), which writes audit.audit_log in the same transaction as the INSERT.
What to change in build3.access-review.test.ts (tester only):
- Case at :406: replace "one access/audit entry ... action from the seeded access-action list" with: `env.accessCalls` has length 0 (no access-log write is specified), the INSERT into identity.access_reviews runs on `ctx.tx` (the audited transaction), and NOTES appears in neither `env.accessCalls` nor `env.logCalls`. Drop the SEED_ACTIONS assertion (or the constant if unused).
- Case at :425: model the audit failure where it really happens — the INSERT statement throws (trigger error, e.g. pgError on the INSERT) — and assert the handler rejects with no 2xx, instead of a throwing `audit.access`.
No implementation change; all other cases stand.
