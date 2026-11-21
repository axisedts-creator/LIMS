# SEC-ABUSE-1 dispute (writer, round 3, after LD-414 migration landed)
Part (1) is implemented (migration 20261119100000 + limiter peek/clear + store-backed loginStaff); all SEC-ABUSE-1 tests and the verify set are green (206 api + 95 + 61 web).
Three existing tests now fail because their fake Postgres pre-dates LD-410, not because of a code defect:
1. core/pipeline/__tests__/bff-key.test.ts:26 and :271/:299 — vi.mock('pg') answers only `ratelimit_hit`; `SELECT hits, last_hit FROM app.ratelimit_peek($1,$2)` gets `rows: []`. The real function (OUT params) always returns exactly one row, so pg.ts treats no row as backend failure -> fail closed (LD-237 "fail closed"; same rule ratelimit_hit already has, pg.ts:10) -> 503 instead of auth.login_failed.
2. core/pipeline/__tests__/identity-actor.test.ts:35 / :274 — same fake, same cause.
3. core/pipeline/__tests__/stage05-rate-limit.test.ts "a public operation (no claims) ... nothing consumed" pins the behaviour LD-237 (3) replaces (already reported in round 2).
Fix asked of the tester: in both pg fakes add `if (/ratelimit_peek/i.test(t)) return { rows: [{ hits: 0, last_hit: null }] };` (and `ratelimit_clear` -> `{ rows: [{}] }`); update or drop case 3 per LD-237 (3).
Not changed in code on purpose: answering "no row = zero failures" would make a misbehaving store fail open on the login tier.
Unrelated reds in the same run (not touched): core/sync *.live (need DB), sync registry static DELETE scan (core/sync/retention.ts), sync runbook codes, mfa.repo.platform-event definer count, role-packs route-guard, ci-scripts service-key grep.
