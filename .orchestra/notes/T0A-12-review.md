APPROVE
- Diff 3659864..HEAD: only change to owned code is packages/shared-ts/test/decimal.test.mjs:24-28 — skips `workspace:` values exactly per LD-40 / ruling; regex not loosened; LD-40 cited in comment. Rest is .orchestra note/CR renames.
- External deps still exact-pinned (contracts=workspace:*, others x.y.z); decimal = stdlib bigint, no lib to pin.
- No RLS/routes/permissions/PHI/secrets in scope; no invented names; paths owned.
- Ran: T0A-12 verify.cmd 102/102 pass; `tsc --noEmit -p packages/shared-ts` clean.
- Not re-reviewed: impl commit 723840e (outside given range; impl unchanged since). Open (noted by writer): lint rule not wired into CI runner; Dart side not done.
