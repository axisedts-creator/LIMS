# T0B-PROVFIX-2 impl (writer)
Files: services/api/src/modules/identity/service/tenant.service.ts (guard only, 1 line + comment).
Root cause: router ctx.now() returns an ISO string (core/pipeline/index.ts:150); guard passed it on as s.now; inviteAdmin called s.now.getTime() -> TypeError.
Fix: guard normalises `now: new Date(ctx.now ? ctx.now() : Date.now())`; covers inviteAdmin, provisionTenant, setStatus/terminate `at`, nextFiscalYear.
[CONV] fix at the single shared entry (guard), no per-caller patches; core not edited.
Checks: verify.cmd (3 files) 195/195 pass; tsc --noEmit clean.
CR: .orchestra/cr/T0B-PROVFIX-2.md nonblocking (core errors.ts:130, err_message + first stack line for native errors only, REQ-SEC-026).
Open: founder redeploys after PROVFIX-1 + PROVFIX-2 merge, then retries Provision / Invite administrator.
