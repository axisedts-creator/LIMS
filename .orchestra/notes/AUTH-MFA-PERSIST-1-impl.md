# AUTH-MFA-PERSIST-1 impl (writer) - LD-248
Files: `apps/web/src/features/admin/auth/actions.ts` (+`refreshSessionStateAction`), `MfaEnrolment.tsx` (+optional props `refreshAction`, `navigate`; 409 recovery), `apps/web/src/app/(auth)/auth/mfa/enrol/page.tsx` (wires `refreshAction`). No API, SQL or migration change: tests found no defect.
- [CONV] 409 (`common.version_conflict`) on start: no danger alert; refresh once; `mfa_pending` -> `/auth/mfa`, `active` -> `/`, else or on refresh failure/throw -> one `role=status` line + "Sign in" link to `/auth/login`.
- [CONV] `refreshSessionStateAction` returns only `{ok,state}` / `{ok,code}`; token never leaves the server; 401 handled by `sessionCall`.
- Ran: api identity suites 1042 pass / 5 skipped; web t12 (mfa-409, mfa-qr, actions, forms) 118 pass. `tsc` shows only the existing msw `onUnhandledRequest` typing error class in test files (also in the new tester file).
- Open: full `pnpm -s verify` not run by me; live "new authenticator every login" needs push-cloud.ps1 (migration 20261115157000) + one deploy; no code change can fix an undeployed DB.
