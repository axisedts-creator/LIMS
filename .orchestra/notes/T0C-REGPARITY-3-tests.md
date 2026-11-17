# T0C-REGPARITY-3 tests (re-pinned per LD-331 option B: string, minLength 0, empty string when unavailable; no type arrays, no lint change)
- New: tools/codegen/__tests__/regparity3-openapi.test.ts (shape, Ajv success body + port-failure body [empty string + label], null rejected, example 2083/84-000077, lint clean, no type array/nullable anywhere, lint-openapi.ts untouched, generated client types `next_receipt_no: string;` + label, MSW handler, staleFiles).
- regparity2-openapi.test.ts:406 keeps `type` "string" (unchanged on this branch; nothing to edit).
- Run: `.orchestra\notes\T0C-REGPARITY-3-verify.cmd` (= `cd tools/codegen && npx vitest run __tests__/regparity3-openapi.test.ts __tests__/regparity2-openapi.test.ts __tests__/lint-openapi.test.ts`).
- Implementer: edit frontdesk.yaml (schema + example ~3804), run codegen (refreshes packages/api-client-ts/src/{frontdesk.ts,server/operations.ts}, packages/fakes/src/msw/handlers.generated.ts, plus the 2 LD-331 files contracts/ports/generated/access-actions.ts and db/seeds/003_audit__g_cs_access_actions.sql).
- Label wording not pinned (non-empty, <=64); description regexes are in the shape test.
- Pre-existing: staleFiles() may already flag the two access-actions outputs (spec commit 71d1ccdd3), so the freshness test fails until codegen runs.
