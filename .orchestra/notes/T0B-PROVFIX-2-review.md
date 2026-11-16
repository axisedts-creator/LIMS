APPROVE

# T0B-PROVFIX-2 review (reviewer)
Diff 70b7606d2..HEAD: tenant.service.ts guard (1 line + LD-295 comment), new handlers/__tests__/tenant.realchain.{test,helpers}.ts, notes, nonblocking CR. Only owned/listed paths; no core, migration, policy, grant, contract, spec or render.yaml change.
Root cause confirmed: core/pipeline/index.ts:150 `now: () => ...toISOString()` (string); guard passed it through, inviteAdmin `s.now.getTime()` (tenant.service.ts:350) threw TypeError after GoTrue. Fix `new Date(ctx.now ? ctx.now() : Date.now())` in the single shared guard covers inviteTenantAdmin, provisionTenant, setStatus/terminate `at`, nextFiscalYear (:558). Same pattern as ird.service.ts:76 / user.service.ts:244.
Tests: real createPipeline + real createDb (withTenantScope allowlist, system actor) + real repos/access log; only pg pool and GoTrue faked. Covers done_when (1) invite chain, (3) provisionTenant every scoped statement in order incl. no ird_annex insert (LD-295), claims per statement, idempotency body serialisable, rollback paths, tenant-session refusal, HMAC key unset fails closed. No PHI (synthetic .test addresses), no secrets (synthetic HMAC key).
Checks run: verify.cmd 3 files 195/195 pass; `tsc --noEmit` clean. Not re-run: the "13 fail without fix" claim (reviewer read-only; tester note documents it).
CR (4): .orchestra/cr/T0B-PROVFIX-2.nonblocking.md, Blocking? NO, core errors.ts err_message + stack0 for native errors only, REQ-SEC-026 respected.

Observations (not defects of this task, out of its file list; for lead):
- Same `ctx.now()` assumed-Date pattern in other identity services fed by the real pipeline: auth.service.ts:112/125/145/199/212 (`ctx.now().getTime()`), platform-staff.service.ts:156, support.service.ts:154, tenant-access.service.ts:80, self.service.ts:120. Any `.getTime()`/Date use there will TypeError on staging the same way; worth a follow-up sweep task.
- impl note cites `.orchestra/cr/T0B-PROVFIX-2.md`; actual file is `T0B-PROVFIX-2.nonblocking.md` (note typo only).
