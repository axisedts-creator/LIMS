APPROVE

Scope: `git diff 988b6a37..HEAD` = commits 328502b4 [tester], 1e0c65ce [writer]. The earlier API-T11 impl/debug commits (4fb711d8, bf568154, 07cbc43c) are ancestors of 988b6a37, so they are outside this range.
- services/api/src/modules/instruments/__tests__/boot.test.ts:232,245: only the timeout arguments change, 30_000 -> 120_000, and each cites LD-86. No assertion is touched. vitest.config.ts is unchanged. No other timeout is raised. This matches LD-86 exactly.
- Writer: no code change. Only .orchestra/notes/API-T11-impl.md gets one verify line, which LD-86 allows.
- No new names, routes, error codes, permissions, PHI, secrets or SQL/RLS in the diff. All paths are owned by C7 or are notes.
Non-blocking (outside this diff, recorded in the impl note): `attachments/adapters/*` qpdf sanitise not built; worker uses gen_random_uuid() (v4); there are no DB-level RLS or race tests.
