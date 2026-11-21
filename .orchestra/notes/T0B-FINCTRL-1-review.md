APPROVE

Scope: git diff 40a861dcf..HEAD (LD-394 writer fix only).
- accounts.repo.ts (holdEntry, releaseEntry) and discountPolicy.repo.ts (all 20 sites listed in LD-394) moved from `${CONST}` to `+` concat; runtime SQL is character-identical (spaces kept on both sides of each split). No SQL text, parameter order, column list or behaviour change.
- Grep: zero `${` left in either file. Only owned paths touched (2 repo files + own notes).
- repo.static.test.ts 32/32 pass; `tsc --noEmit` clean (services/api).
- No new names, permissions, error codes, logging or secrets introduced; RLS/tenancy unaffected (no migration change).
Not re-run: live PG17 suites (pure syntax move; prior runs 2-4 green per impl note).
