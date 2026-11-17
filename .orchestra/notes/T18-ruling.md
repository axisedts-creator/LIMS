TESTS_WRONG — the test's module loader cannot resolve spec-mandated .ts handler files; no assertion is at fault.
1. spec/program/02-CONVENTIONS.md:126 mandates `handlers/<operationId>.ts` (one file per operationId); the T18 brief lists `handlers/{listAuditEntries,getAuditEntry,listAccessLogEntries,listAuthEvents}.ts`. All four exist as .ts.
2. audit-view.handlers.test.ts:11 uses a variable dynamic import `` import(`../handlers/${op}.js`) ``; Vite's dynamic-import-vars rewrites it to a glob over `../handlers/*.js`, which matches nothing. Reproduced by arbiter: 15/19 fail with `Error: Unknown variable dynamic import: ../handlers/listAuditEntries.js` before any handler code runs.
3. No spec line requires dynamic loading; the failure is test harness mechanics, not behaviour.
Fix (tester): replace `load` at line 11 with static namespace imports, e.g.
   `import * as listAuditEntriesMod from '../handlers/listAuditEntries.js';` (x4) and
   `const MODS: Record<string, any> = { listAuditEntries: listAuditEntriesMod, ... }; const load = async (op: string) => { const m = MODS[op]; return (m[op] ?? m.default); };`
Keep every assertion (fail-closed, auth.unauthenticated, no input reflection, end-to-end cases) unchanged.
