APPROVE

Scope: `git diff 353fefd..HEAD` (003 regen, 010 regen, gen-seeds.ts, gen-access-actions.ts, T0B-09_seeds.test.sql §5, CR close).
- LD-30: 010 sets claims then `SET LOCAL ROLE lims_app` per tenant block; claims cleared at end. 001-003 start `SET LOCAL ROLE lims_owner` (LD-38/LD-41). Seeds run `--single-transaction` / `psql -1` (run-suites.sh:50, up.ts:81), so SET LOCAL holds.
- LD-41: gen-access-actions.ts emits lims_owner + `ON CONFLICT (code) DO NOTHING`; 003 regenerated, not hand-edited; CR T0B-09-003 closed.
- Fixed `created_at` on insert-only link tables makes healed rows identical; deterministic, synthetic only.
- Test §5 change matches arbiter ruling exactly (system actor claims, no app.maintenance, rerun_done before assertion).
- No PHI, no secrets, no invented names; paths owned or covered by LD-38/LD-41.
Checks run by reviewer: `node --test tests/db/T0B-09.seeds.test.mjs` 15/15 pass; `bash db/tests/run-suites.sh db/tests/seeds/T0B-09_seeds.test.sql` no `not ok`, psql exit clean; `pnpm codegen:check` (tools/codegen) clean; codegen vitest 13/13 files pass.
Not verified: `pnpm dev:up` end to end (up.ts:79 loads every db/seeds file; prod subset = 001-003 by prefix, tested in node suite).
