APPROVE
Scope reviewed: `git diff 0f859303..HEAD` (commits 43e7949b, 5908dfe1, 28dc984b).
- The only code change is apps/web/src/features/anatomic/nav.manifest.ts:8. It removes `chord: 'g t'` from `anatomic.tracking` and leaves every other field the same. This is exactly what the binding lead decision (AUTO 2026-11-14T07:19:48) requires, and it matches the C11 spec 04-UI-UX.md:16 ("C11 drops its chord (no CR needed)"). `homecollection.handovers` keeps `g t`, as C17 04-UI-UX.md:12,16 requires.
- No new names, no PHI, no secrets. There is no RLS, permission, idempotency or error-code surface in this diff. Notes files only were otherwise touched.
- Non-blocking, cross-chunk (not a writer defect; the writer may not edit C11 tests): apps/web/src/features/anatomic/__tests__/t19.nav.test.ts:17 still expects `chord: 'g t'` and now fails (`npx vitest run src/features/anatomic/__tests__/t19.nav.test.ts`: 1 failed / 6 passed, run 2026-11-14 07:25). Lead or C11 tester must change that EXPECTED entry to `chord: undefined`, per C11 04-UI-UX.md:16.
- Not re-run by reviewer: HC-T18 suite (writer reports 135/135), E2E, lint.
