TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons:
1. IC (rank 4) is the source of truth for schema content. spec/program/03-INTERFACE-CATALOG.md:266-267 (§3.4) and :453-455 (§3.9) put `required` names inside `then`/`not`/`else` subschemas that do not declare those properties. spec/program/02-CONVENTIONS.md:868 requires this 2020-12 `if`/`then`/`else` form. Ajv `strictRequired` rejects valid IC content, so the test must not turn it on.
2. spec/program/03-INTERFACE-CATALOG.md:774, :809 and :847 carry `"x-extensible": true`, and 02-CONVENTIONS.md:459 and :866 make it a normative marker. A strict Ajv must have the keyword registered. Registering it keeps strict mode in force; it does not loosen it.
3. The spec asks only for "ajv 2020-12" (C0 02-TRD.md:764) and "IC examples validate" (02-TRD.md:1051, task done_when). No spec line requires `strictRequired`. TRD:111 says "strict" only for `@lims/shared-ts/validation`, and the other Ajv strict checks stay on.
4. lax(): REQ-SEC-080 (spec/research/02-security.md:160) is about rejecting unknown fields in *data shapes*. `if` (IC:266, :453) is a condition, and `not`/`then`/`else` (IC:267, :454-455) carry only `required`. Adding `additionalProperties:false` to the `if` would change what the IC says it means.

Change the test (events.test.ts):
- l.84: `new Ajv2020({ strict: true, strictRequired: false, allErrors: true })`, and add `ajv.addKeyword({ keyword: "x-extensible", schemaType: "boolean" })` before addSchema.
- l.253: lax() must not descend into the keys `if`, `then`, `else` or `not` (keep the existing enum/const/required skips). Leave every other assertion, including the $defs deep-equal at l.148, unchanged.
- The writer's [CONV] `"type":"object"` in template allOf[1] is not tested and is not part of this ruling.
