# T-01 impl (writer, chunk C3-catalog-pricing) — retest round
- Files: services/api/src/modules/catalog/{index.ts, permissions.ts, config.ts, handlers/index.ts, __tests__/probes/pending.json}.
- Fix: pending.json was never committed in b6ac383; regenerated from handlers/index.ts keys (107 ops, same order).
- [CONV] all 107 stubs in handlers/index.ts share one `notImplemented`; per-op files come with each implementing task.
- [CONV] config ints: `^\d+$` + Number.isSafeInteger, error names key; result frozen. No `ports` in manifest yet.
- Ran: verify.cmd set (boot.test.ts + catalog unit) = 69/69 pass. `tsc --noEmit` clean.
- Full @lims/api: 1314 pass, 5 fail (5000ms timeouts; each passes alone). Cause + ask in T-01-dispute.md (owner C0-0D).
