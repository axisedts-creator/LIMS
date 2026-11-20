APPROVE

Range df0e08e70..HEAD: only the tester's snapshot regeneration (ed6b86568) and the impl note line (c266ab0c5). Neither services/ nor contracts/ changed (git diff --quiet).
- Checked against LD-422: `node tests/security/classify-authz.mjs` output is byte-identical (JSON) to the committed tests/security/authz-classification.json.
- 93 operations changed class versus df0e08e70. All 93 moved to guarded-exact. None moved to a weaker class, and no operation was added or removed (1177 total).
- Billing, payment and audit x-permissions now show 0 operations classed unguarded or guarded-other. cancelInvoice was guarded-other (reprint) and is now exact, billing.invoice.cancel.
- `node --test tests/security/authz-classification.test.mjs tests/security/authz-billing-payments-audit.test.mjs`: 40/40 pass.
- This range adds no permission, policy, SQL, error code, log line or secret.
- Out of scope, already named by the lead: about 297 billing and payments suite tests need IdentityPort fixtures, which is a separate tester round. I did not run vitest or the DB-bound suites.
