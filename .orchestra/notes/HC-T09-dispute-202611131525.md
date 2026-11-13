# HC-T09 dispute (writer) — test helper does not compile

All 4 DB suites fail at transform, 0 tests run (log: `.orchestra/notes/HC-T09-run.log`):
`dispatch/helpers.ts:211:13: ERROR: Multiple exports with the same name "seedWorld"`

Cause: commit e6004e3b added `export const seedWorld = ...` (line 211) but the re-export list at line 19-20 still names `seedWorld`. Before the change that name came from the import; now it is a local declaration exported twice.

Fix (test file, tester-owned): remove `seedWorld` from the `export { ... }` list at helpers.ts:20. No assertion change; no implementation change needed (arbiter ruling: enqueue is correct).
