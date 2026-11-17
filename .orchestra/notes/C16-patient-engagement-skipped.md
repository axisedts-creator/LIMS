# C16 plan tasks skipped (not in task JSON)

None. 06-IMPLEMENTATION-PLAN.md marks no task as blocked or deferred.

Not tasks (nothing to skip): CR-C16-020 (push) and CR-C16-021 (coupons) are DEFERRED in 08; plan section 4 lists CR candidates only.

Notes:
- T-REL1 included with empty verify: needs client-owned store accounts and signing keys in the C1 secret store (founder decision 2026-11-06).
- Tasks needing kit components (CR-C16-016/017) or other-chunk fakes are included; the plan says they wait or use fakes.
- Story-level AC refs in the plan (e.g. `US-EN-01, 02`) expanded to ids from 01-PRD.md. T-Q1, T-OPS1 and the hardening tasks have no AC ids in the plan, so `acs` is empty.
- Flutter tasks use verify `cd apps/patient_app && flutter test`; the rest use `pnpm -s verify`.
