# T-01 impl (C5 writer). NOTE: overwrites C1's T-01-impl.md (same id collision as T-01-tests.md)
- Files: api `modules/lab/{index,permissions,config}.ts`, `modules/lab/handlers/index.ts`; worker `jobs/lab/index.ts`; round 2: `core/openapi.ts` (lead AUTO 2026-11-07T19:16:21).
- [CONV] 55 stubs in handlers/index.ts come from one explicit operationId list; each throws LimsError `common.internal`.
- [CONV] worker: the 9 §7.2 consumer stubs reject with `common.internal`; `tasks: {}`, `crontab: []`.
- [CONV] config: bools accept only `true`/`false`; ints must be decimal digits >= 1; the error names the LIMS_LAB_* key.
- Round 2: `AJV_OPTIONS.keywords = ['x-coded-set']` (strict and removeAdditional:false unchanged). The real repo now boots.
- Tests: api lab 71/73, worker lab 3/5. Every remaining failure is a test bug (dispute #1, #3, #4). tsc clean.
- Open: core tests now fail because lab is the first autoloaded module (dispute #5, cross-chunk).
