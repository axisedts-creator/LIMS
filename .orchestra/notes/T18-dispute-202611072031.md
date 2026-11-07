# T18 dispute (writer) — audit-view.handlers.test.ts loader cannot resolve .ts handlers
Test: `services/api/src/modules/identity/__tests__/audit-view.handlers.test.ts:11` — `await import(\`../handlers/${op}.js\`)`.
Failure (all 15 handler-module tests): `Error: Unknown variable dynamic import: ../handlers/listAuditEntries.js` (vite/dynamic-import-helper.js).
Why the test is wrong: Vite rewrites a variable dynamic import into a glob over `../handlers/*.js`; the handlers are `.ts` files (as the brief requires),
so the glob is empty and every op throws before reaching the code. Static `import ... from '../handlers/listAuditEntries.js'` resolves fine (NodeNext .js->.ts).
Evidence: a temporary copy of this test with only the loader swapped to static imports of the 4 handlers -> 19/19 pass (copy deleted, not committed);
service 64/64 and static 16/16 pass unchanged.
Suggested fix (tester): replace `load` with a static map, e.g. `import * as H1 from '../handlers/listAuditEntries.js'` ... `const MODS = { listAuditEntries: H1, ... }`,
or `import.meta.glob('../handlers/*.ts')`. No assertion needs to change.
