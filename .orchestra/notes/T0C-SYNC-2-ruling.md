TESTS_WRONG — the item 1 contract tests require free-form `type: object` fields, which the spec forbids; the object-only guarantee belongs in the DB and the service.

Reasons:
1. spec/program/02-CONVENTIONS.md:423: "Every object schema in every spec has `additionalProperties: false` ... CI lint fails a spec object without it." A free-form JSON document typed `type: object` needs `additionalProperties: true` (or omitted), so it breaks this rule. Lint rule 3 enforces it (tools/codegen/lint-openapi.ts:195-197, CI step 7 at 02-CONVENTIONS.md:1143).
2. The task brief, done_when (1) and (6), names the columns `local_payload`/`server_payload` as jsonb and asks for "closed schemas with additionalProperties false". It never requires these wire fields to be `type: object`. The tests add a requirement the spec does not contain.
3. The only open-object exemption is LD-119 (lint-openapi.ts:62-64, exactly ONE entry). Adding entries is lint policy owned by the lead, and an arbiter cannot grant it. Option (a) in the dispute is out of scope.
4. The guarantee is kept where the spec allows it: the DB CHECK `sync_conflict__payloads__ck` / `sync_operation__payload__ck` and the T0B-SYNC-2..5 service validation.

Change to tools/codegen/__tests__/sync2-openapi.test.ts, describe "T0C-SYNC-2 review: JSON document fields are objects (item 1)":
- Remove the 4 generated `${sch}.${f} is type: object` tests (FIELDS loop, lines ~779-784).
- Remove "a non-object merged_payload, local_payload or server_payload fails ajv" (lines ~789-798).
- KEEP the migration test for `sync_conflict__payloads__ck` (line ~785). It is DB-level, consistent with the spec, and already passing.
- Item 2 tests are unchanged.
