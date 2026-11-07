## C3-catalog-pricing (lane/C3)
# T-01 impl (writer, chunk C3-catalog-pricing) — retest round 3
- Files: services/api/src/modules/catalog/{index.ts, permissions.ts, config.ts, handlers/index.ts, __tests__/probes/pending.json}.
- Fix: pending.json absent again (previous "committed" claim was wrong: never in git index); regenerated from catalog.yaml operationIds (107, all stubs) and committed.
- [CONV] all 107 stubs in handlers/index.ts share one `notImplemented`; per-op files come with each implementing task.
- [CONV] config ints: `^\d+$` + Number.isSafeInteger, error names key; result frozen. No `ports` in manifest yet.
- Ran: verify.cmd test set (5 core files + catalog unit) = 6 files, 203/203 pass.
- Open: none.

## C5-lab-workflow (main)
# T-01 impl (C5 writer). NOTE: overwrites C1's T-01-impl.md (same id collision as T-01-tests.md)
- Files: api `modules/lab/{index,permissions,config}.ts`, `modules/lab/handlers/index.ts`; worker `jobs/lab/index.ts`; round 2: `core/openapi.ts` (lead AUTO 2026-11-07T19:16:21).
- [CONV] 55 stubs in handlers/index.ts come from one explicit operationId list; each throws LimsError `common.internal`.
- [CONV] worker: the 9 §7.2 consumer stubs reject with `common.internal`; `tasks: {}`, `crontab: []`.
- [CONV] config: bools accept only `true`/`false`; ints must be decimal digits >= 1; the error names the LIMS_LAB_* key.
- Round 2: `AJV_OPTIONS.keywords = ['x-coded-set']` (strict and removeAdditional:false unchanged). The real repo now boots.
- Round 3 (after the ruling and the revised tests): no code change. api lab 73/73, worker lab 5/5. api tsc clean (worker has no tsconfig).
- Open: core tests fail because lab is the first autoloaded module (ruling #5, escalated to the lead for C0).
