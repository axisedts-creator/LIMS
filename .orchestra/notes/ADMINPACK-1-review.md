APPROVE

Review of 10433c669..3a9750297 (ADMINPACK-1, LD-254, LD-189).

Checked (run by reviewer, 2026-11-16):
- `cmp services/api/.../role-packs.data.yaml spec/program/11-ROLE-MATRIX.data.yaml`: identical. Diff is +23 corp_admin / +17 std_admin only; no spec/, contracts/, service, SQL, policy or registry change (LD-189).
- ADMIN_EXTRA (matrix-replay.test.ts:64-74) equals the section 3.3 table: 6 quality + 7 inventory + 3 micro/anatomic + 1 lab + 6 other = 23; std_admin 17 (the 6 others pre-held). Counts 115/39, 102/35 pinned in data, loader, admin-authority tests; no other role count changed.
- Targeted gate: api role-packs 5 files 238/238 pass; web nav-complete.admin-pack 9/9 pass; regenerated report unchanged after run (tree clean).
- Typecheck: no error in touched files (web total 290 = VERIFY-GREEN-1 baseline; api tsconfig excludes __tests__).
- RLS, idempotency, rate tier, error codes: n/a (data and tests only). No PHI, no secrets. Paths within the brief's file list (8 task files + role notes).

Notes for the lead (not defects of this task):
1. Brief/spec conflict: done_when says neither admin holds payments.* or inventory.bench.record, but the spec data (bc657dab0, must stay byte-identical) gives corp_admin payments.merchant_config.manage/read + payments.reconciliation.read and std_admin both merchant_config codes + inventory.bench.record (pre-R5a, tenant_admin base / sheet tick). admin-authority.test.ts:244-251 pins exactly these as the only left-out holdings, so any further left-out grant fails. Matches R5a wording "no money authority beyond the pack". Lead to confirm or order removal (spec-side change).
2. `services/api/package.json` has no `identity:apply-role-pack` script, so the founder-steps command fails as written until a one-line script is added (flagged in ADMINPACK-1-founder-steps.md). package.json was outside this task's file list.
3. matrix-replay R5a test infers "ticked" from holdings (the sheet has counts, not per-role cells); a new whole-feature grant would pass it alone, but byte-identity + pinned counts + admin-authority close that gap.
