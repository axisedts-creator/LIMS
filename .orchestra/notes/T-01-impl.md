# T-01 impl (writer, chunk C3-catalog-pricing) — overwrites C1's T-01-impl.md (name clash; C1's stays in git history)
- Files: services/api/src/modules/catalog/{index.ts, permissions.ts, config.ts, handlers/index.ts, __tests__/probes/pending.json}.
- [CONV] all 107 stubs live in handlers/index.ts sharing one `notImplemented` handler; per-operationId files (02-TRD §3) are added by the task that implements each op. pending.json = all 107 ops.
- [CONV] config ints: `^\d+$` + Number.isSafeInteger, error names the key; result frozen. manifest has no `ports` yet (CatalogPort task).
- Ran: catalog unit = 47/47 pass. `tsc --noEmit` clean. eslint: config ignores modules/catalog (not linted).
- Full @lims/api suite: 11 fail. 5 boot.test.ts deterministic: core tests autoload the real modules dir without JWT config -> `module catalog: bearerJwt operations need LIMS_CORE_JWT_* config`. CR filed: .orchestra/cr/T-01.md (to C0-0D).
- Other 6 (errors/openapi/auth http/observability http/health): 5000ms timeouts under full-suite load; rerun of those 5 files alone = 1 timeout. Baseline without catalog not verified.
- LD-06/LD-17 are C1 infra decisions; not applicable to this task.
