Title: CR-C4-BL01: core ajv must accept the `x-coded-set` schema keyword
From chunk: C4            To owner: C0-0D
Type: bug
Blocking? yes — BL-T01 (06-IMPLEMENTATION-PLAN row BL-T01, done-when "Core boots with module").
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  `bootstrap()` with the billing module throws
  `FastifyError: Failed building the validation schema for POST: /v1/billing/invoices/:invoice_id/cancel, due to error strict mode: unknown keyword: "x-coded-set"`.
  contracts/openapi/billing.yaml uses `x-coded-set` in request bodies, as mandated by spec/program/02-CONVENTIONS.md:573 and
  spec/chunks/C0-foundation-contracts/02-TRD.md:341 (rule 6; also enforced by tools/codegen/lint-openapi.ts:183). The request-validator
  ajv built in services/api/src/core/openapi.ts:80-88 (schemaController) runs in strict mode and registers no `x-coded-set` keyword, so any
  module whose body schemas carry it cannot boot. billing is the first mounted module with it; frontdesk.yaml (8 uses) and others will hit the same.
Proposed change (exact): in services/api/src/core/openapi.ts, register `x-coded-set` (and, for parity with core/events/publish.ts:22, `x-extensible`)
  as annotation-only keywords on every ajv instance the schemaController/response validator builds, e.g. pass
  `customOptions: { ...AJV_OPTIONS, keywords: [{ keyword: 'x-coded-set', schemaType: 'string' }, { keyword: 'x-extensible', schemaType: 'boolean' }] }`
  (same for BODY_AJV_OPTIONS / RESPONSE_AJV_OPTIONS). No validation semantics; code-set membership stays a handler/service check.
Backward compatible? yes — adds accepted annotation keywords only.
Tenant/security impact: none; no RLS/PHI/public-surface change. REQ-SEC-080 (removeAdditional:false) unchanged.
IRD/regulatory impact (billing changes only): none.
Alternatives considered: stripping `x-coded-set` in the billing module before mount (rejected: billing cannot touch core schema compilation, and every module would repeat it); `strict: false` globally (rejected: hides real schema typos).
Tests that will prove it: core unit test compiling a body schema with `x-coded-set` succeeds; services/api/src/modules/billing/__tests__/unit/boot.test.ts "bootstrap resolves and every billing operation is mounted" turns green.
