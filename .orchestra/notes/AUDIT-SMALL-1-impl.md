# AUDIT-SMALL-1 impl (LD-224)
- NEW apps/web/src/app/page.tsx: redirect-only root route (platform -> /platform; tenant_staff -> first navEntries entry the actor may open; else /auth/login). [CONV] force-dynamic.
- services/api/src/core/db/tx.ts: in run(), after mapDbError, one `log.error` line `db_error` with request_id, sqlstate, schema, table, column, constraint, routine, operationId (absent pg fields = null). Never message/detail/hint/where/values. Written once per final failure (retries that succeed log nothing).
- services/api/src/core/db/sqlstate.ts: DbErrorDeps.log gains optional `error`; mapping untouched (logger with only `warn` still works).
- Tests run: API sqlstate.log.audit-small-1 + sqlstate.test.ts 64/64; web root-page 11/11. Full `pnpm verify` NOT run by me.
- Open: pre-existing TS errors elsewhere not touched (see AUTH-ACTOR-2 notes).
