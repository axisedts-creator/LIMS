# T0D-BUILD-4 dispute (debugger): boot.test.ts per-test timeout
Test: services/api/src/modules/analytics/__tests__/boot.test.ts:246 and :265, `}, 60_000);` on the two AN-T01 real-repo boot tests.
Why wrong: services/api/vitest.config.ts (LD-110) sets testTimeout 300000 because the real boot takes 100-140 s on the shared machine; the per-test 60_000 overrides it. First boot here takes 79-85 s, so it fails on load, not on the new operation (31 of 31 mount is never reached before the cap).
Fix (tester): raise both caps to 300_000 (or remove them), nothing else. Debugger cannot edit tests.
