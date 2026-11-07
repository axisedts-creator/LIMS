# API-T01 impl
- Files: `services/api/src/modules/instruments/{index.ts, permissions.ts, config.ts, handlers/index.ts}`.
- [CONV] 41 stubs generated from one OPERATION_IDS list (as lab T-01), each throws `common.internal`; later tasks add `handlers/<operationId>.ts`.
- [CONV] config field names per test seams; ints decimal digits only, bools only `true`/`false`; production-like = NODE_ENV=production or LIMS_CORE_ENV staging/production (keys required, sketch drivers forced off; explicit `true` throws).
- No `deviceToken` authResolver yet (API-T03): core has no handler for the scheme, so device ops fail closed 401.
- Result: 67/69 pass. 2 boot-against-real-repo tests fail in `modules/reporting/config.ts` (import-time `loadReportingConfig(process.env)` requires LIMS_CORE_ENV) — same 2 failures in `lab/__tests__/boot.test.ts`, pre-existing, not C7-owned.
- Open: lead/C6 to fix reporting import-time env read, or verify.cmd to set `LIMS_CORE_ENV=ci`. tsc: only pre-existing TS5097 in packages/shared-ts.
