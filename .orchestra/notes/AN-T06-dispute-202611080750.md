# AN-T06 dispute (writer) — 2 of 85 tests cannot pass with any correct implementation
Run: `.orchestra\notes\AN-T06-verify.cmd` → 83 pass, 2 fail. Whole `jobs/analytics` suite: 346 pass, only these 2 fail.

1. `backfill.test.ts` › "a failure in step 2 rejects (retry), step 1 stays done…" (line 132-142).
   The hook throws on `insertRollup daily_income` when `a.values.includes('2026-11-08')`. Step 1 is the half-open range [2026-11-01, 2026-11-08), so its own
   INSERT binds `[tenant, '2026-11-01', '2026-11-08', runId]` — `'2026-11-08'` is step 1's `to`. Step 1 therefore throws too; no `daily_income` replace
   from `2026-11-01` is ever committed, and `expect(...).toContain('2026-11-01')` (line 137) fails. Step 2 must be told apart by `from`
   (`a.values[1] === '2026-11-08'`), not by `includes`. Task behaviour (step 1 committed before step 2 starts, retry idempotent) is implemented as the file header says.
2. `self_check.test.ts` › "a failing comparison rejects the task…" (line 135-139).
   Failure is injected by the fake db hook (`a.kind === 'other' && /analytics\.daily_results/`). The world's `mine()` (tasksFake.ts l.107-118) classifies every
   R2/R3/R4 compare and RETURNS its rows without calling `base()`, so the fake db hook is never invoked for a compare; the R3|results compare is classified
   before the hook can see it. The test needs the failure injected at `w.ctx.tx.query` (as purge.test.ts l.189 does) or `mine()` must call the hook first.
   Task behaviour (a rejected compare propagates, nothing swallowed) is plain `await`, with no try/catch.
