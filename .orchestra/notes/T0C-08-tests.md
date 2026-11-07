# T0C-08 tests (AC-0C-4.1, 4.2)
- File: `tools/codegen/__tests__/mocks.test.ts` (Vitest; derives operations from real contracts/openapi, no fixtures).
- Run: `.orchestra\notes\T0C-08-verify.cmd` (= `cd tools\codegen && npx vitest run __tests__/mocks.test.ts`).
- Fails now: no `mock:*` scripts / Prism pin in root package.json; `packages/fakes` absent (package.json, msw 3.0.3, `src/msw/handlers.generated.ts` `export const handlers`, `server.ts` `export const server`); codegen lacks gen-msw.
- Contract (header of test): scripts `prism mock contracts/openapi/<m>.yaml --host 127.0.0.1 --port 41xx` (unique) + `mock:list`; Prism `@stoplight/prism-cli` 5.16.0; handlers match any origin, one per operationId, return lowest 2xx + first JSON example; unmatched/wrong-method requests error.
- Not tested (spec-ambiguous): exact port = 4100+index (CM §3 index base unclear); Prism actually serving (needs prism install + network, not in unit test).
- NOT run: implementation absent, `msw` not installed; collects/fails on missing files.
