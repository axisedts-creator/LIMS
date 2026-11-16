Title: CR-C0B-SWEEP2-001: required mixed-case header parameters (If-Match, Idempotency-Key, X-Lims-*) can never validate
From chunk: C0-0B            To owner: C0-0D (services/api/src/core/openapi.ts)
Type: bug
Blocking? yes — T0B-SWEEP-2 (C0-foundation-contracts 06-IMPLEMENTATION-PLAN), test `services/api/test-sweep/__tests__/sweep2-artifacts.test.ts:47` (done_when 2: write and platform requests must pass input validation; <=10% SHALLOW). Sweep-2 run: 508 SHALLOW vs limit 61.
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  Core `schemaController.compilersFactory.buildValidator` (openapi.ts:99-107) makes Fastify treat the validator as custom
  (fastify/lib/schema-controller.js isCustomValidatorCompiler), so fastify/lib/validation.js:290-293 compiles header
  schemas without `lowerCaseHeadersSchema`. The schema keeps `required: ['If-Match']` while Node delivers `if-match`, so every
  operation with a required If-Match / Idempotency-Key / X-Lims-* header answers 400 common.validation_failed
  (`/If-Match common.field_required`) even when the header is sent. Sweep-2: 324 ops on /If-Match, 270 on /Idempotency-Key,
  ~90 on X-Lims-*. Real clients hit the same 400: optimistic-concurrency and idempotent writes are unreachable.
Proposed change (exact): in `buildValidator` (openapi.ts:101-105), when `c.httpPart === 'headers'`, compile a copy of
  `c.schema` with `properties` keys and `required` entries lower-cased (same transform as fastify's `lowerCaseHeadersSchema`,
  validation.js:78-211); body/query/params unchanged. Alternative location: installRouteHooks' onRoute (openapi.ts:~138) before compile.
Backward compatible? yes — requests that send the headers start validating; nothing that passes today fails (absent required headers still 400).
Tenant/security impact: no RLS change, no PHI field, no new public surface. If-Match and Idempotency-Key checks start running as specified.
IRD/regulatory impact (billing changes only): none.
Alternatives considered: harness sends upper-case keys (impossible: HTTP/inject lower-case them); harness patches route schemas (masks a real BUG, edits core behaviour from a non-owner chunk: rejected); relax the 10% threshold (rejected by arbiter ruling .orchestra/notes/T0B-SWEEP-2-ruling.md).
Tests that will prove it: core unit test — route whose schema requires `If-Match`, request with `if-match: "1"` -> not 400; same request without it -> 400 common.field_required. Then `pnpm --filter @lims/api sweep`: sweep2-artifacts.test.ts:47 passes unchanged.
