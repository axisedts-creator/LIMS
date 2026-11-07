# API-T01 impl
- Files: `services/api/src/modules/instruments/{index.ts, permissions.ts, config.ts, handlers/index.ts}`.
- [CONV] 41 stubs generated from one OPERATION_IDS list (as lab T-01), each throws `common.internal`; later tasks add `handlers/<operationId>.ts`.
- [CONV] config field names per test seams; ints decimal digits only, bools only `true`/`false`; production-like = NODE_ENV=production or LIMS_CORE_ENV staging/production (keys required, sketch drivers forced off; explicit `true` throws).
- Round 3 (after ruling, test fixed 11cacea): no implementation change needed. boot.test.ts 57/57 pass (2026-11-07).
- tsc: only pre-existing TS5097 in packages/shared-ts/src/bsdate (not C7-owned); no instruments errors.
- Open: none for API-T01. deviceToken resolver arrives in API-T03.
