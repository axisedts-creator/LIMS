# API-T11 debug
Cause: both failures in boot.test.ts, none in T11 code. (1) stale `IMPLEMENTED` list lacks `submitMessageBatch` (E04 done in T09) -> stub assertion fails. (2) "boots and mounts" 30 s timeout is a parallel-load flake; passes alone.
Fix: none in implementation (test edit forbidden). Wrote API-T11-dispute.md. T11 suites (handlers 12, service 44, contract 18) all pass.

## Round 2 (2026-11-10)
Stale IMPLEMENTED list fixed by tester. Only fail left: boot.test "boots and mounts" 30 s timeout (boot.test.ts:218-229, fixed `30_000` arg); fails alone too (~32-36 s), sibling boot test takes 21 s.
Cause: `bootstrap()` autoloads + compiles every module spec in a cold vite-node run on this box; T11 files import only node:crypto + local modules, no heavy dep. Same flake seen before T11 (obs of API-T09/T10 runs). Not T11 code.
Fix: none in implementation (no smallest-change lever; test timeout is test-owned). Needs ruling: raise that test's timeout (or LIMS test config) -- not a spec contradiction, so no dispute file.

## Round 3 (2026-11-10)
Latest verify log: 122/123 pass; only boot.test "boots and mounts" fails, 30 s timeout (took 49 s under load; sibling boot test 28 s). Same cause as round 2: cold `bootstrap()` of all modules, no T11 import in the path. No implementation lever, test timeout (boot.test.ts:229) is test-owned.
Fix: none. Needs ruling: raise that test's timeout (or vitest testTimeout for boot.test). T11 suites (handlers, service, contract, worker scan) pass.

## Round 4 (2026-11-10)
Verify log: 121/123. (1) boot "boots and mounts" 30 s timeout (40 s run), same cold `bootstrap()` cause as rounds 2-3. (2) "fails closed" test: `module reporting: index.ts exports no manifest`, but reporting/index.ts:31 exports `manifest` and T11 never touched it (last change C6-T37). Cascade from the still-running timed-out import, not a code defect.
Fix: none in implementation; T11 files are in neither path. Needs ruling: raise boot.test timeouts (test-owned) or run it serially.
