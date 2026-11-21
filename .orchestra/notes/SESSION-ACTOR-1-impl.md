# SESSION-ACTOR-1 impl (writer)
- NEW db/migrations/20261115155000_identity__add_session_actor_definer.sql; db/meta/definer-inventory.yaml (+1 row); db/tests/isolation/_registry.sql regenerated (+1 line; the generator also touched 370 probe files, line endings only, git diff empty).
- services/api identity: NEW service/session-actor.ts (loadSessionActor: maps role_codes->roles, tenant_code only for tenant, fail closed common.internal + log "session actor missing"); auth.service.ts, session.service.ts, handlers/resolveSession.ts (log into SessionCall), repository/auth-events.repo.ts + mfa.repo.ts (sessionActor).
- [CONV] login: actor read after all checks, before any session write; resolve: after lapse/blocked and BEFORE the GoTrue refresh, so a missing actor never loses a rotated refresh token.
- [CONV] suspended tenant, deactivated membership, inactive role/staff => no row => common.internal (tester's assumption kept). actor_type is not filtered (partner memberships served).
- Ran: the 3 SESSION-ACTOR-1 test files 44/44 pass; identity + core suites 6258 pass, 1 fail = role-packs/route-guard.test.ts (pre-existing). tsc: no new error (identity TS2430 Hctx errors and quality errors are pre-existing).
- NOT run: pgTAP (no psql/docker) incl. the new migration and SESSION-ACTOR-1_session_actor.test.sql. CR to C2/C0: .orchestra/cr/SESSION-ACTOR-1.md; C2.T6 item 2 withdrawn.
