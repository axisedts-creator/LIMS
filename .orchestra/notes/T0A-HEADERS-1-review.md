APPROVE
# T0A-HEADERS-1 review (reviewer)
- Diff 6142c46f5..HEAD: only `services/api/src/core/openapi.ts` (headers branch of buildValidator), two new tests in `services/api/src/core/__tests__/`, and lane notes. Owned paths only.
- Fix matches done_when (1): copy of the header schema with top-level `properties` keys and `required` lower-cased (same as Fastify lowerCaseHeadersSchema); body/query/params untouched; input not mutated; comment cites LD-277/LD-278.
- done_when (2) covered by header-validation.test.ts (lower/mixed case accepted, each missing header -> 400 common.validation_failed naming it, schema case variants, body/query stay case-sensitive).
- done_when (3)/(4) covered by header-contract.test.ts (535 ops via real factory, drop-one refused) and the >64 Idempotency-Key / bad If-Match cases. No new error code, no contract/auth/RLS/migration/idempotency change, no PHI, no secrets. RLS not in scope.
- Ran: verify.cmd 3 files / 21 tests pass; `tsc --noEmit` clean.
- done_when (5): counts recorded in impl notes (535; If-Match 324; Idempotency-Key 280; X-Lims-* 46), second sweep T0B-SWEEP-2 can be reset. Counts differ from the C0-0B sweep (270/~90) because this lane is main before C0-0B; that's expected.
- LD-278 reminder: do not tell the founder to retry Provision until T0A-HEADERS-1 AND PLATFORM-PROVISION-1 are both merged to main.
