APPROVE

Review of dfc98762..HEAD (HC-T20 round 3, LD-171).
- Diff touches only owned paths: apps/web/src/features/homecollection/__tests__/hc-t20.settings.test.tsx (tester) and .orchestra/notes/HC-T20-impl.md (writer note). No implementation change, as LD-171 requires.
- Test changes match LD-171 items 1-3 exactly: listbox-closed wait and row 3 = Cash wait before submit; { timeout: 10000 } on the waitFor calls at :180 and :250. Regex /once|duplicate|already|unique/i and expect(puts()).toHaveLength(0) unchanged; no assertion deleted, skipped or loosened (item 4).
- No new names, PHI, secrets or invented items in the diff.
- Verify re-run by reviewer 2026-11-14 with HC-T20-verify.cmd flags (--maxWorkers=1 --testTimeout=60000 --hookTimeout=120000 --teardownTimeout=120000): Test Files 5 passed (5), Tests 148 passed (148).
- Previously approved scope (RLS/permissions/error codes, US-12-2, US-13-5) unchanged by this diff.
Open (not blocking, needs lead): hc-t18.nav duplicate chord "g t" noted in HC-T20-impl.md.
