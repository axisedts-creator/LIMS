# T0C-01 dispute (writer) — test contradicts IC; 12 fail, 175 pass

Test requires `$defs` deep-equal IC fences (events.test.ts:148) AND compiles with `new Ajv2020({ strict: true })` (l.84) AND the `lax()` walk (l.249). IC content verbatim cannot satisfy all three:

1. **strictRequired** (`strict:true` turns it on). IC §3.4 `billing.invoice.issued.v1` `then.not.anyOf[0].required:["order_id"]` and IC §3.9 `lab.result.verified.v1` `then.required:["verified_by_membership_id"]` name properties not declared in that subschema. Ajv: `strict mode: required property "order_id" is not defined at ".../then/not/anyOf/0" (strictRequired)`. Valid JSON Schema; schema cannot compile under the test's options. 4 tests fail.
2. **x-extensible keyword** — IC §3.17 `report_kind`, §3.18 `recipient_kind`, §3.19 `entity_type` carry `"x-extensible": true` (02-CV §7.2, CR-C3-003). Ajv: `strict mode: unknown keyword: "x-extensible"`. 6 tests fail.
3. **lax() flags `if` predicates** — IC §3.4 / §3.9 `Payload.if` has `properties` without `additionalProperties:false`. `if` is a condition, not an object shape; adding `additionalProperties:false` would make the condition false for every real payload (wrong branch always taken). 2 tests fail.

Proposed test fix: `new Ajv2020({ strict: true, strictRequired: false, allErrors: true })` + `ajv.addKeyword("x-extensible")` (or `{ keyword: "x-extensible", schemaType: "boolean" }`), and `lax()` skip keys `if` (and `not`, which holds only `required`).
Verified: throwaway copy of events.test.ts with exactly those 3 changes (deleted after) = 173/173 pass, schemas unchanged. Current suite: 175 pass / 12 fail (incl. registry-equality 14/14).

Impl state (uncommitted in tree): `contracts/package.json` (@lims/contracts; ajv 8.17.1, yaml 2.8.1, vitest 3.2.4), `contracts/events/` 27 files generated from IC. [CONV] Added `"type":"object"` to template `allOf[1]` and its `aggregate` (Ajv strictTypes requires it; semantics unchanged, envelope already types both).
