# T0B-BOOTGATE-1 tests
- NEW services/api/src/core/__tests__/pending-operations.test.ts (+ fixtures `fixtures/pending/*`, `fixtures/pending-auth/*`); EDIT boot.test.ts (+2 tests, AC-0D-1.2).
- Run: `.orchestra/notes/T0B-BOOTGATE-1-verify.cmd` = `pnpm --dir services/api exec vitest run src/core/__tests__/pending-operations.test.ts src/core/__tests__/boot.test.ts src/__tests__/real-modules-boot.test.ts`.
- Now: 26+ fail for the right reason (`missing handler for operationId ...`, `boot ... succeeded but must fail`; real modules billing, frontdesk).
- Expects: `ModuleManifest.pendingOperations?: readonly string[]`; stale warning via app.log (opts.logStream, level warn) or console.warn, ONE line naming module + id; non array -> error naming `pendingOperations` + module.
- 501 stub: status 501, `application/problem+json`, body.code `operation_pending` (NOT in contracts/errors.yaml, so reply directly, not via toProblem), operationId in the body, `request_id` present; bad body on a pending op stays 400, no token 401.
- Production: `NODE_ENV=production` (read from process.env at boot) fails with message naming module + id unless `LIMS_ALLOW_PENDING_OPS` is exactly `1`; stale entries fail too. Tests set it in process.env AND the loadConfig env.
- DEVIATION: test `release gate no pending operations` runs only with LIMS_RELEASE_GATE=1 (it.runIf). Unconditional it would be red on main for the whole life of the pending list and the task verify could never pass. Lead: say if you want it unconditional.
- Real-module test requires pending list == spec operations without a handler, per module (billing, frontdesk today).
