# T0D-OFFLINE-1 dispute (writer)
Test: offline1.static.test.ts > "shell JavaScript grows by at most 25 KB gzipped" (line 24).
Why it is wrong: it calls `ts.transpileModule` / `ts.ScriptTarget.ES2022` from `typescript`, but apps/web pins typescript 7.0.2 (native port): its JS entry exports only `version` and `versionMajorMinor`, so the test throws `TypeError: Cannot read properties of undefined (reading 'ES2022')` before it measures anything. No implementation change can make it pass.
Fix proposal (tester): strip types with node's built in `module.stripTypeScriptTypes(src, { mode: 'transform' })` (node 26, no new dependency) and drop comments, or gzip the raw .ts as an upper bound.
Measured by the writer with that method: 7 implementation files = 7.1 KB gzip (budget 25 KB). All other 80 tests pass.
