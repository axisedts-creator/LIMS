# T0D-08 tests (tester)
Files: services/api/src/core/events/__tests__/{publish.test,helpers}.ts · core-repo/__tests__/{dead-letters.test,repo.test,helpers}.ts · audit/__tests__/access.test.ts
Run: `.orchestra\notes\T0D-08-verify.cmd` (vitest, three dirs only). Expected now: fail on missing modules `../publish.js`, `../index.js`, `../dead-letters.js`, `../access.js`.
Covers AC-0D-5.1-5.3 (publish), 5.7-5.14 (dead letters), 6.5 (memberships.list), CentreRow.phoneDisplay, REQ-SEC-024 tenant filter, AB-22 payload leak scan.
Interfaces I had to assume (spec gives shapes, not constructors; all deps injected, no real DB):
- events/publish.ts `createEvents({ producer, metrics?, log? }).publish(ctx, type, { aggregate, idempotencyKey, payload, causationEventId? })`; schemas read from contracts/events.
- core-repo/index.ts `createCoreRepo({ withTenantScope(tx, tenantId, systemActorId, fn), systemActorOf(module), log?, metrics? })` -> CoreRepository; core-repo/dead-letters.ts exports `stripPayload`.
- audit/access.ts `access(ctx, entry)`. Existing `db.withTenantScope` is identity-only and 3-arg: the impl must supply the core-internal 4-arg form (A23.2) via the injected dep.
Not verifiable here (no database): real WHERE semantics of the A9.2 filters, RLS/`__platform` policies, `dead_letters__resolution_note__ck` (fake re-implements it) -> need db/tests SQL tests.
