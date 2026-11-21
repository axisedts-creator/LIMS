# SEC-HDR-1 impl (writer)
- New `services/api/src/core/observability/security-headers.ts` (one onSend hook) + 2 lines in `core/bootstrap.ts`: nosniff + Referrer-Policy no-referrer on every response; no-store on 2xx JSON of a non-public operation (route schema has operationId, no x-public) only when Cache-Control is absent.
- `apps/web|portal|partner/src/middleware.ts`: X-Frame-Options DENY + Permissions-Policy; partner also Referrer-Policy no-referrer. Web `camera=(self)` (frontdesk/components/NewPatientForm.tsx), all else `()`. No CSP value or header name touched.
- [CONV] set in middleware (not partner next.config) so every response kind (redirect, rewrite, problem+json) carries them.
- Ran: api sec-hdr1 13/13, web 12/12, portal 11/11, partner 18/18 green.
- Open: `pnpm -s verify` fails at `@lims/web#typecheck` on pre-existing test-file errors (msw `onUnhandledRequest` TS2353 in many `__tests__`, `printcfg1.setup.ts` TS2348); none in SEC-HDR-1 files. Tester-owned files, not edited.
