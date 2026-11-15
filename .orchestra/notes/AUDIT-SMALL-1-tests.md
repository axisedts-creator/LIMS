# AUDIT-SMALL-1 tests (LD-224; RS-08 root route, RS-12 logging half)
- Web: `apps/web/src/app/__tests__/root-page.audit-small-1.test.ts` (+ `vitest.audit-small-1.config.ts`). Needs `apps/web/src/app/page.tsx` (default async export, redirects only). Nav fixture is mocked; landing = first `navEntries` entry whose permission the actor holds.
- API: `services/api/src/core/db/__tests__/sqlstate.log.audit-small-1.test.ts` via `createDb({log})`: one `log.error` per mapped DB error, exact keys request_id, sqlstate, schema, table, column, constraint, routine, operationId; sentinels for message/detail/hint/where/values never logged; mapping table unchanged.
- The logger passed to createDb needs `error`; a logger with only `warn` must still map (tested).
- Run: `.orchestra\notes\AUDIT-SMALL-1-verify.cmd` (also reruns existing sqlstate.test.ts).
- Fail now: web suite cannot import `../page`; API "writes one line" cases fail (no log.error); mapping cases already pass.
