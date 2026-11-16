Title: CR-C0B-SWEEP2-001: required mixed-case header parameters (If-Match, Idempotency-Key, X-Lims-*) can never validate
From chunk: C0-0B            To owner: C0-0D (services/api/src/core/openapi.ts)
Type: bug
Blocking? no (T0B-SWEEP-2 done_when 2 threshold "<=10% of write+platform SHALLOW" cannot be met until fixed; the sweep reports them as SHALLOW with the failing field)
Problem: core `schemaController.compilersFactory.buildValidator` (openapi.ts:99-107) makes Fastify treat the validator as custom
  (fastify/lib/schema-controller.js:33 isCustomValidatorCompiler), so fastify/lib/validation.js:290 skips `lowerCaseHeadersSchema`.
  The header schema keeps `required: ['If-Match']` while Node delivers `if-match`, so every operation with a required
  If-Match / Idempotency-Key / X-Lims-App-* header answers 400 common.validation_failed `/If-Match common.field_required`
  even when the header is sent. Sweep-2 run: 324 ops on /If-Match, 270 on /Idempotency-Key, 44+39+5+2 on X-Lims-*.
  Repro (fastify 5.12.8): same route + header schema, default controller -> 200, custom buildValidator -> 400.
Proposed change (exact): in installRouteHooks' onRoute (openapi.ts:138), lowercase `schema.headers` property names and
  `required` entries before compile (same as fastify's lowerCaseHeadersSchema), or do it inside buildValidator when httpPart === 'headers'.
Backward compatible? yes (requests that sent the headers start validating; nothing that passes today fails).
Tenant/security impact: none new; If-Match / idempotency checks start running as specified (REQ-SEC unchanged).
Alternatives considered: harness cannot send upper-case keys (HTTP/inject lowercase them).
Tests that will prove it: core unit test: POST with `if-match: "1"` on a route whose spec requires If-Match -> not 400; rerun `pnpm --filter @lims/api sweep`: SHALLOW on write+platform <= 10%.
