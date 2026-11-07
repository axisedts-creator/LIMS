# T-01 impl (writer, chunk C3-catalog-pricing) — retest round 2
- Files: services/api/src/modules/catalog/{index.ts, permissions.ts, config.ts, handlers/index.ts, __tests__/probes/pending.json}.
- Fix: pending.json was again absent on disk (never committed); regenerated from handlers/index.ts keys (107 ops) and committed this time.
- [CONV] all 107 stubs in handlers/index.ts share one `notImplemented`; per-op files come with each implementing task.
- [CONV] config ints: `^\d+$` + Number.isSafeInteger, error names key; result frozen. No `ports` in manifest yet.
- Ran: verify.cmd set (5 core files + catalog unit) = 203/203 pass. Full @lims/api: 1319 pass, 6 skipped, 0 fail. `tsc --noEmit` clean.
- Open: none.
