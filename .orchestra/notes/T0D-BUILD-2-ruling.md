TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)
Round 2 (2026-11-22 ~15:30 NPT, dispute .orchestra/notes/T0D-BUILD-2-dispute.md after LD-451 reset; supersedes round 1 below, whose two edits stand).
1. settings/settings.test.ts:198 — audit actor_id comes from claims `sub` (spec/chunks/C0-foundation-contracts/05-SCHEMA.md:269; 01-PRD.md:152 AC-0B-5.1),
   and claims are built by the core only, never by module code (02-TRD.md:601; 07-SECURITY.md:19 REQ-SEC-013). The kit's appTx sets sub = SYS_ACTOR,
   actor_type 'system' (frontdesk/__tests__/integration/helpers.ts:55,62), so no handler can make actor_id = caller. Change line 198 to
   `actor_id: SYS_ACTOR` with comment "kit appTx claims (frontdesk helpers.ts:55); caller attribution pinned by updated_by at :108/:118; trigger sub->actor_id
   is a C0 schema test (05-SCHEMA.md:387, §10 test 20)". Do not change the shared appTx. Keep the action/tenant/changed_columns/count/tenant-B asserts.
2. probes/st4-actor-type.test.ts:62-71 — UNOWNED_STUBS = [] (probes/kit.ts:29) is correct: the brief done_when (1)-(2) gives both settings ops an owner.
   it.each([]) yields an empty suite, which vitest fails; that is a kit artefact, not a spec rule. Replace the it.each with one `it` asserting
   `expect(UNOWNED_STUBS).toEqual([])` (keeps the guard: a future unowned stub must be re-added with the it.each), or wrap as describe.skipIf(UNOWNED_STUBS.length === 0).
Tester applies both; no source change. Writer then reruns verify.cmd incl. the web step (not yet run).

## Round 1 (15:13 NPT)
1. settings.test.ts `refused` (line 39): '*' = any JSON Pointer path (02-CONVENTIONS.md:415,:427; sales/helpers.ts:81).
2. boot.test.ts IMPLEMENTED (line 45) lists 'updatePartnerSettings' (T0D-BUILD-2, LD-447).

## LEAD ITEM (LD-451, 2026-11-22 15:14 NPT)
Docker stopped blocked PG17; no code or test change for that. After reset: writer/debugger change nothing unless a real assertion fails; tester files stay with tester; reviewer edits nothing.
