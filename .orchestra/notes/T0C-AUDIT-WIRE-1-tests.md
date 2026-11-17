# T0C-AUDIT-WIRE-1 tests (tester)
Files (services/api/src/modules/identity/__tests__/): `audit-wire.operations.test.ts` (wiring + KNOWN_STUBS), `audit-wire.handlers.test.ts` (guard, shape, repo spy, stage 9).
Run: `.orchestra\notes\T0C-AUDIT-WIRE-1-verify.cmd` (one pnpm --dir services/api vitest line).
Now: 9 operations + 43 handlers tests fail, all because the 4 ops are the `notImplemented` stub. Ran: known stubs today = listRolePacks, applyRolePack, listAccessReviews, recordAccessReview (confirmed).
FINDING for writer: the core does NOT enforce x-permission; no pipeline stage calls assertRole, and stage 9 answers common.internal (non-prod) for a 2xx without it. The 4 handlers/service never call it, so registering alone would 500. Writer must call `ctx.ports.IdentityPort.assertRole(ctx, { permission: 'audit.log.read' })` once, first, before any read (e.g. in handlers/_audit-view.bind.ts, after the unauthenticated check). Handler files may change for that; no contract/SQL/grant change.
Assumed: repo fns listAudit/getAudit/listAccess/listAuth of repository/audit-read.repo.ts (vi.mock wraps them); guard errors pass through unchanged.
