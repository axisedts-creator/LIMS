# T-01 tests (C5 tester) — NOTE: overwrites the C1 T-01 notes of the same name (id collision, see report)
- Files: `services/api/src/modules/lab/__tests__/boot.test.ts`, `services/worker/src/jobs/lab/__tests__/manifest.test.ts` (vitest).
- Run (repo root): `.orchestra\notes\T-01-verify.cmd` (api then worker vitest; no DB needed).
- Covers: manifest validates + produces 7 events; handlers == 55 lab.yaml operationIds, each stub rejects `common.internal` (no 501); LAB_PERMISSIONS == lab.* codes, every op bearerJwt + registered x-permission; LIMS_LAB_* config; real-repo boot mounts all ops, unauth = 401; worker subscriptions == 02-TRD §7.2 == EVENT_CONSUMERS.lab, stubs reject `common.internal`.
- SEAMS I assumed (spec silent): exports `manifest` / `handlers` / `LAB_PERMISSIONS` / `loadLabConfig(env)` with fields autoverifyHookEnabled, catalogCacheMaxEntries, labelWaitSeconds, worklistMaxRows.
- Later tasks replacing a stub add its operationId to `IMPLEMENTED` in boot.test.ts (tester-owned).
- LD-06/LD-17 (infra run.sh, ansible-lint) belong to C1's T-01; not applicable here.
