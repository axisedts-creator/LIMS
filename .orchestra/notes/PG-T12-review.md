APPROVE
Re-review after fixes 9320ca97 / d86095af.
- Item 1 fixed: `handlers/intents.ts:226-227` now throws `payments.intent_not_verifiable` when the gateway gives no answer or the result is not settled (TRD §6.5; P4 error list). Unit still rolls back.
- Item 2 fixed: `staff.http.test.ts` P4 `it.each` (settle / record_exceeding_due, gateway `code:0`) expects 409 `payments.intent_not_verifiable`, intent still `held_for_review`, no ledger, no event, no transition, no access_log row.
- `service/outcome.service.ts` change is additive (`reason`, `settleSets`, both default off); payments module path, owned by C15.
Earlier checks unchanged (names, perms, front_desk P5/P24b vs P24 403, aal, P3 429, If-Match, access-log per §5.1, DTO allowlist, tenant + centre scope, no PHI/secrets).
Verify cmd: 170/170 pass; tsc: 0 errors under modules/payments.
