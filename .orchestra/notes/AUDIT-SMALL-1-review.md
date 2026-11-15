APPROVE

Reviewed `git diff 87f9b7ac..HEAD` (AUDIT-SMALL-1, LD-224). 9 files, 6 non-notes (within the 8-file cap); all C1-owned paths.

- RS-08 `apps/web/src/app/page.tsx`: uses `getShellSession` (same as the shell), platform -> `/platform`, tenant_staff -> first `navEntries` entry by `hasPermission`, else `/auth/login` (existing route, middleware uses it). `ShellSession.actor.permissions` is always an array (c2.ts normalises, LD-222), so no crash on a non-active session. `/` is not session-exempt in middleware, so the header is set. No copy, no styling, no middleware/auth-action change.
- RS-12 `services/api/src/core/db/tx.ts`: one `log.error` 'db_error' per final mapped failure in `run()` (requestTx and identityAuthTx), keys exactly request_id, sqlstate, schema, table, column, constraint, routine, operationId; only string-typed pg fields, never message/detail/hint/where/values. Retries that succeed log nothing. Mapping in sqlstate.ts unchanged (type-only edit; `error` optional). Production logger (boot.ts LogFns) has `error`.
- No contract, spec, policy or migration change; no 42501 remap; no PHI or secrets.
- Tests run by reviewer: API sqlstate.log.audit-small-1 + sqlstate.test.ts 64/64 pass; web root-page 11/11 pass. `tsc --noEmit`: no errors in touched files (api 38 and web errors are pre-existing, elsewhere). Full `pnpm -s verify` NOT green due to those pre-existing errors (not caused by this diff).

Non-blocking note (not a defect of this task): engagement `*.service.ts` and smartreport `library.service.ts` re-map raw pg errors to LimsError before `run()`, so those paths write no db_error line. Extending logging there is outside LD-224's 8-file scope; raise separately if wanted.
