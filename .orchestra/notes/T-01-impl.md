# T-01 impl (writer, chunk C3-catalog-pricing) — retest round 3
- Files: services/api/src/modules/catalog/{index.ts, permissions.ts, config.ts, handlers/index.ts, __tests__/probes/pending.json}.
- Fix: pending.json absent again (previous "committed" claim was wrong: never in git index); regenerated from catalog.yaml operationIds (107, all stubs) and committed.
- [CONV] all 107 stubs in handlers/index.ts share one `notImplemented`; per-op files come with each implementing task.
- [CONV] config ints: `^\d+$` + Number.isSafeInteger, error names key; result frozen. No `ports` in manifest yet.
- Ran: verify.cmd test set (5 core files + catalog unit) = 6 files, 203/203 pass.
- Open: none.
