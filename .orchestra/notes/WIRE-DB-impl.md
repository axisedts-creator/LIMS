# WIRE-DB impl (writer, LD-189)
- NEW services/api/src/modules/identity/claims/dbBinding.ts: createIdentityDbBinding() = frozen facade {identityAuthTx} + bind(); lazy read, UUID check, memoised on success only, in-flight shared, failures common.internal (no id/driver text).
- identity/index.ts: resolver gets binding.db; createServices registers binding.bind via deps.identityDb.register (identity only).
- core/pipeline/boot.ts: only identity's deps carry identityDb.register; after pool exists bindIdentityDb({readActorId, open}); no pool = never bound = rejects as before.
- [CONV] lookup: SELECT actor_id FROM core.g_system_actors WHERE module = $1 AND is_active ($1='identity'), via pg pool; not exactly 1 row -> fail closed. open() = createDb(... identitySystemActorId) exposing identityAuthTx only. bootstrap.ts, allowlists, claims untouched.
- [CONV] unbound error keeps old detail text 'identity: ctx.db not wired into module construction' (manifest-ports.test.ts pins it).
- Tests: new 2 files + identity-auth/tx/identity claims/manifest-ports green. Open: staging-boot `.env.example lists every render.yaml name` fails (7 names; render.yaml/.env.example not mine, not WIRE-DB); route-guard AppShell nav regex test fails (untouched files). Live lims_app SELECT on core.g_system_actors unverified.
