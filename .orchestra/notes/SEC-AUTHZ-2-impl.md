# SEC-AUTHZ-2 impl (writer)
- New: core/pipeline/authz-central.ts (stage 8a, skipReason, validateAuthzExceptions, loadAuthzExceptions), authz-exceptions.json (`[]`). Edited: pipeline/index.ts, pipeline/boot.ts, config.ts (authzMode, default shadow, unknown value throws), openapi.ts (permission, scheme), observability/metrics.ts (counter). authz-guard.ts untouched.
- Review fixes: device actors now call assertRole through the guard wrapper like users (IdentityPort resolves device_kind to its fixed permissions); invented `credential_permission` claim removed. Boot passes the operationIds of all loaded module specs to loadAuthzExceptions, so an unknown operationId stops boot.
- [CONV] files outside the brief list (boot, config, openapi, metrics) are the minimum wiring the pinned names need. IdentityPort read via portsFor('frontdesk') (identity not in PORT_CONSUMERS for its own port).
- [CONV] stage 9: user/device assert through az.identity(port); system/patient/partner/portal decisions mark stage 9 via az.identity(no-op port); exception-listed ops use the raw port; skipped ops (public, bffSession, no x-permission, platform.*) untouched.
- [CONV] patient/partner/portal denied on bearerJwt only. Shadow swallows non-auth errors (logs authz_central_error); enforce fails closed.
- Ran: verify vitest 7 files 497/497 pass; classification test 19/19 pass; src/core 2272 pass, 1 fail (storage adapter.test.ts flags core/health.ts from T0B-OPSDOC-1, not this task); tsc no error in touched files.
- Open: storage/health.ts failure belongs to T0B-OPSDOC-1 owner.
