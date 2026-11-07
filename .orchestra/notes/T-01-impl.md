# T-01 impl (C5 writer) — NOTE: overwrites C1's T-01-impl.md (same id collision as T-01-tests.md)
- Files: api `modules/lab/{index,permissions,config}.ts`, `modules/lab/handlers/index.ts`; worker `jobs/lab/index.ts`.
- [CONV] 55 stubs generated in handlers/index.ts from one explicit operationId list (no 55 placeholder files); each throws LimsError `common.internal`.
- [CONV] worker: 9 §7.2 consumer stubs reject `common.internal`; `tasks: {}`, `crontab: []` (§8 tasks come with their tasks; no Phase-1 crontab).
- [CONV] config: bool only `true`/`false`; ints decimal digits >= 1; error names the LIMS_LAB_* key. No LabPort in manifest yet.
- Tests: api 71/73, worker 3/5. BLOCKED: test regex bug (dispute `T-01-dispute.md` #1) + core ajv `x-coded-set` (CR `.orchestra/cr/T-01.md`).
- tsc (services/api): no errors in lab files. Full suite/lint not run.
