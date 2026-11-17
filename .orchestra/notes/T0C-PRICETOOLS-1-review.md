APPROVE

Round 3 (HEAD a51c14585), reviewed `git diff 67708b8c4..HEAD`; delta since round 2 (9d2286cbf): probe-rows/catalog.sql, lint-openapi.ts, notes.
- Round 2 item fixed: db/tests/fixtures/probe-rows/catalog.sql now equals generator output (`node db/tools/gen-isolation-probes.ts --check` on HEAD: "ok (448 probe files, 18 fixture files current)").
- tools/codegen/lint-openapi.ts (debugger): `lintRepo` yields `setImmediate` before/after the sync `lintOpenapi`; result unchanged, path owned by C0-0C (01-CHUNK-MAP tools/codegen). OK.
- Ran: `npx vitest run __tests__/pricetools1-openapi.test.ts` 62/62 pass (lint + codegen --check green). Not run by the reviewer: pgTAP/docker suites, services/api vitest.

Carried from rounds 1-2 (re-confirmed): names verbatim (7 operationIds, catalog.price_list.manage/read reused, no new code, catalog.code_duplicate / catalog.import_not_committable); Idempotency-Key on the 4 POST writes; tier general; RLS ENABLE+FORCE + tenant policies on both new tables, error table append only, no array cast so `::uuid[]` n/a; migration additive/idempotent with down note; no PHI/secrets; FIELD MAP, push-cloud founder step and offline classification in notes; pendingOperations += 7 (LD-325(b)).

Notes for the lead (not defects of this task): 3 DROP INDEX on LD-321 authority without a CR file need confirmation; T0B-PRICETOOLS-1 must add the date-window filter to billing assignment reads; pinned counts in db/tests/catalog/T0B-10.C3_schema.test.sql and tests/db/T0B-DBSEED-1.fixtures.test.mjs baselines need a re-pin ruling; file count over the 10 cap only by generated/gate files.
