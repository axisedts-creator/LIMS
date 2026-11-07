APPROVE

Re-review (round 2) of `e51b650..HEAD`, fixes in 2db6028 + 92c6e4a.
- Fix 1 resolved: specimen.state.ts checks the table first (`lab.specimen_invalid_transition`), then inactive non-S13/S14 → `lab.specimen_inactive` (409, contracts/errors.yaml:124, CR-C5-005). Tests: S2/S4/S11 inactive → specimen_inactive 409; illegal pair inactive stays invalid_transition.
- Fix 2 resolved: result.state.ts R6 fails closed when `verifiedBy`/`approvedBy` is missing or the two are equal → `lab.self_approval_forbidden` (403, errors.yaml:116). Tests cover missing/empty/equal; the allowed-table and exhaustive sweeps pass distinct ids.
- Verified: `vitest run src/modules/lab/domain/__tests__` → 3 files, 100/100 pass; `tsc --noEmit` → 0 errors.
- Diff touches only owned paths (services/api/src/modules/lab/domain/**) and T-02 notes. Pure domain: no DB, no logs, no PHI, no secrets. RLS, permissions, idempotency and rate tier do not apply (no routes or tables).
