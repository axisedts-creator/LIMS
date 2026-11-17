TESTS_WRONG — the test asserts `custom_fields` is an open object (`additionalProperties` absent/true/schema); the spec forbids open objects on the wire, and the brief scopes custom_fields to "here only the column".

Reasons:
1. spec/program/02-CONVENTIONS.md:423 — "Every object schema in every spec has `additionalProperties: false` ... CI lint fails a spec object without it." spec/chunks/C0-foundation-contracts/02-TRD.md:338 (§5.2 rule 3) repeats it; tools/codegen/lint-openapi.ts:196-197 transcribes it. The test's own "lintRepo reports no violation" case cannot pass beside the open-object case: the test contradicts itself, the spec does not.
2. spec/program/02-CONVENTIONS.md:466 (X10, §4.12) — 3.0.3 ∩ 3.1 only; OAS 3.0 has no `patternProperties`, so a closed keyed map is not available (repo precedent: contracts/openapi/identity.yaml:4-5).
3. LD-119 (lint-openapi.ts:62-64) is "exactly ONE entry" for LD-78 signed bytes; extending it is a lead decision, not implied by LD-310. Option (A) rejected.
4. Brief done_when (1): custom_fields is "validated against per tenant custom field definitions defined in the next task; here only the column". The DB column stays jsonb object; the wire shape just has to be closed and bounded.
5. Wire shape the test must assert (writer option B, array form): `custom_fields: { type: array, maxItems: <number>, items: { type: object, additionalProperties: false, required: [code, value], properties: { code: $ref _common Code, value: { type: string, maxLength: <number> } } } }`. The service maps array <-> jsonb object (code = key); duplicate codes rejected by the service (T0B-REGAPI-1).

Changes to tools/codegen/__tests__/regparity1-openapi.test.ts (tester):
- line 49 PARITY: `custom_fields: [{ code: "blood_group", value: "O+" }, { code: "referral_note", value: "synthetic" }]`.
- lines 117-123: rename to "custom_fields a closed, bounded code/value list"; assert `c.type === "array"`, `typeof c.maxItems === "number"`, item (deref) `additionalProperties === false`, `required` contains code and value, `value.maxLength` a number; drop the open-object assertion.
- line 156 bad values: keep `"x"`; replace `{ custom_fields: [] }` (now valid) with `{ custom_fields: { blood_group: "O+" } }` and add `{ custom_fields: [{ code: "x", value: "y", extra: 1 }] }`.
- line 165: keep `{ custom_fields: [1] }` (still rejected). Everything else unchanged; pgTAP/migration tests unchanged.
