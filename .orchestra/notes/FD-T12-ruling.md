TESTS_WRONG — harness defect, not a spec or implementation question; the test runner must not reuse a stale vitest fsModuleCache.
Reasons:
1. Spec requires only that the five consumer files exist and behave per spec/chunks/C4-frontdesk-billing/06-IMPLEMENTATION-PLAN.md:22 (row FD-T12: files + done_when); the specifiers in names.ts:8-12 are correct (6 levels up from __tests__/consumers = services/) and the five files exist with those names.
2. Root cause (reproduced): vitest 5 `fsModuleCache` is on by default (node_modules/.vitest-cache). Entry 31d1a3e1… holds a transform of names.ts written 01:59, BEFORE the writer created the consumer files (02:03); the unresolved specifiers were baked in as `/worker/...`. The cache key is content-based, so the unchanged names.ts keeps hitting the stale entry; a byte-identical copy under a new path misses it — exactly what the writer saw.
3. Proof: `vitest run .../consumers.static.test.ts` = 1 fail ("Cannot find module '/worker/src/jobs/frontdesk/consumers/lab.specimen.rejected.v1.js'"); same command with `--fsModuleCache=false` = 18/18 pass. No code change between runs.
Change for the tester (tests/frontdesk/FD-T12.pg.sh, and FD-T03.pg.sh's run_vitest if shared):
- add `--fsModuleCache=false` to the vitest command in the sed-replaced run_vitest line (or run `pnpm --dir services/api exec vitest --clearCache` before the suite).
- Do NOT rename/move names.ts and do not change its assertions; the test content is correct.
Writer: no implementation change required by this ruling; re-run the DB suite after the harness fix to get the real verdict.
