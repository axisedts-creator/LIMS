# T0C-SYNC-2 dispute (writer, 2026-11-18) — review item 1 tests vs lint rule 3 (LD-119)

Disputed tests: tools/codegen/__tests__/sync2-openapi.test.ts, describe "T0C-SYNC-2 review: JSON document fields are objects (item 1)" (5 tests: SyncUpsert.document, SyncConflict.local_payload/server_payload, ResolveSyncConflictRequest.merged_payload are `type: object`; non-object fails ajv).

Why they cannot pass together with tools/codegen/__tests__/lintfix1-openapi.test.ts "lintRepo(root) is empty":
- A free-form JSON object in OAS 3.0.3 is `type: object` + `additionalProperties: true` (or `{}`). lint-openapi.ts:197 rule 3 flags every `type: object` without `additionalProperties: false`.
- The only exemption, OPEN_OBJECT_ALLOWLIST (lint-openapi.ts:64, LD-119 "exactly ONE entry"), is keyed by operationId + response status, and component schemas are walked with no op context (schemaRoots, lint-openapi.ts:113), so it can never cover SyncUpsert / SyncConflict / ResolveSyncConflictRequest. OAS 3.0 has no patternProperties (precedent: identity.yaml header [CONV]).
- Tried: adding the 4 fields as reviewer asked -> lintfix1 fails with 4 rule 3 violations (core.yaml SyncUpsert.document, SyncConflict.local_payload/server_payload, ResolveSyncConflictRequest.merged_payload).

Needs a lead ruling (lint policy is lead-owned, LD-119), one of:
(a) extend lint rule 3 with a component-level allowlist (core: SyncUpsert.document, SyncConflict.local_payload, SyncConflict.server_payload, ResolveSyncConflictRequest.merged_payload) citing LD-322 + lint tests for it; then the writer adds `type: object, additionalProperties: true`; or
(b) drop the 5 item-1 contract tests; the object-only guarantee stays in the DB (sync_conflict__payloads__ck, sync_operation__payload__ck, now in the migration) and in T0B-SYNC-2..5 service validation.

Done meanwhile: item 1 DB part (CONSTRAINT sync_conflict__payloads__ck, its migration test passes); item 2 complete (SyncErrorCode += 26 domain codes of the 8 wrapped ops, all in errors.yaml, 8/8 + registry tests green).
