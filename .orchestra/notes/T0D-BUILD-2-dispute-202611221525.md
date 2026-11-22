# T0D-BUILD-2 dispute (writer, 2026-11-22 ~15:25 NPT, after LD-451 reset; Docker up, tests/partners/T0D-BUILD-2.pg.sh ran: 859 pass, 1 fail, 1 failed suite)

1. settings/settings.test.ts:198 (audit actor_id = ADMIN_A.userId) - TEST WRONG for this kit.
   Received actor_id 01a1b34e-1000-7eee-9d29-d7ca59a102b5 = core system actor (db/seeds/002_core__g_system_actors.sql:6).
   Cause: the audit trigger takes the actor from request.jwt.claims.sub; fire() (partyset/helpers.ts:84) runs appTx, which sets
   claims with sub = SYS_ACTOR, actor_type 'system' (frontdesk/__tests__/integration/helpers.ts:55,62). In production core/db/tx.ts:49 sets the real caller.
   A handler must not set its own claims (core/auth/claims.ts:1, REQ-SEC-013), so no source fix is correct. Other tenant / changed_columns / count asserts are fine.
   Ask: tester either asserts actor_id = SYS_ACTOR here (kit limit, documented) or makes fire() set claims sub = who.userId, actor_type 'user' (kit change, tester-owned).
   Source updated_by = caller is already pinned at :108/:118 and passes.
2. probes/st4-actor-type.test.ts:62 suite "ST4 spec gap: operations with no owning task" - TEST WRONG.
   probes/kit.ts:26 UNOWNED_STUBS is now [] (BUILD-2 removed the two settings ops), so it.each([]) makes an empty suite and vitest fails it ("No test found in suite").
   Ask: tester drops the describe, or guards it (e.g. it.skipIf / a placeholder it asserting UNOWNED_STUBS is empty).
No source or test edited by the writer. Web step not run (verify.cmd stops at the PG step).
