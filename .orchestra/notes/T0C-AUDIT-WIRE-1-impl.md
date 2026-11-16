# T0C-AUDIT-WIRE-1 impl (writer)
Files: services/api/src/modules/identity/handlers/index.ts (import + register listAuditEntries, getAuditEntry, listAccessLogEntries, listAuthEvents); handlers/_audit-view.bind.ts (guard).
Guard: after the unauthenticated check, `ctx.ports.IdentityPort.assertRole(ctx, { permission: 'audit.log.read' })` once, before any read; guard errors pass through.
[CONV] Missing IdentityPort fails closed with `common.internal` (no guard, no read), per ruling; existing code, no new error code.
No contract/SQL/policy/grant/permission change. Known stubs unchanged: listRolePacks, applyRolePack, listAccessReviews, recordAccessReview.
Ran: audit-wire.operations + audit-wire.handlers + audit-view.handlers = 193/193 pass; tsc --noEmit clean. No eslint installed in repo (lint not run).
Full identity suite: 5908 pass, 2 fail in role-packs/apply-role-pack.script.test.ts (services/api/package.json has 6 scripts vs expected 5). Not from this task (package.json untouched); open for lead.
