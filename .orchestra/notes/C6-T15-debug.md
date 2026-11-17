# C6-T15 debug
Cause: verify failure = `beforeAll` (dynamic import of ../index.js) hit vitest default 10s hookTimeout under CPU contention (cold cache, parallel with manifest.test.ts, other lanes). Not a logic bug: all 116 tests skipped only because the hook died.
Fix: none in implementation. Re-ran verify cmd twice: reports-read alone 116/116 (5.2s), reports-read+manifest 159/159 (3.9s). Flaky only on cold/loaded machine; same class as the known load-test contention.
Suggest (needs lead approval, config not impl): `hookTimeout: 30000` in services/api/vitest.config.ts. Not applied.
