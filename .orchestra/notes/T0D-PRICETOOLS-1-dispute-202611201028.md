# T0D-PRICETOOLS-1 dispute (debugger, 2026-11-20, verify log 10:26:47)

Verify: pricetools1, web-t34, testimport1, web-t38, uilist3 and rs-c2 pass. vitest.emptytbl2.config fails 4 tests in 3 files. None touch a price tool file (all are under features/lab or features/quality-style screens owned by other tasks).

1. emptytbl1.source.test.ts:58 — `lab/components/shared.tsx:77` (`rows?.length === 0 ? <EmptyState …`) matches the EARLY pattern. File last changed by T0D-UILIST-1 / T0D-UISCAN-1 / T0D-OFFLINE-3, not this task. Test is older (T0D-EMPTYTBL-1, LD-310).
2. emptytbl1.source.test.ts:64 — allow-list entry `lab/components/CollectDispatch.tsx` is stale: T0D-UISCAN-1 (LD-353 rule 5, line 52 of that file) moved the EmptyState into the table body, so the pattern no longer matches. Test requires the entry to match.
3. emptytbl2.anatomic.test.tsx:75 (helpers.ts:56) — BatchesScreen no longer repeats "New batch" in the message row. LD-353 rule 6: EmptyState = title, one hint line, at most one button; the page header already carries the action.
4. emptytbl2.other.test.tsx:122 — WorksheetListPage error state still draws `.lims-row-placeholder`. LD-353 rule 6: ErrorState shows message, reference and Retry; a stale test expects no placeholder.

Cause: tests written for T0D-EMPTYTBL-1/2 (LD-310/LD-336) conflict with later binding LD-353 (rules 5, 6) screen changes by other tasks. Fixing them in implementation would mean editing lab/quality screens this task does not own and undoing LD-353 work.
Needed: arbiter ruling on those test files (update allow-list; drop/adjust the "New batch" row and placeholder-after-failure assertions), or a task that owns the lab screens. Price tools code is not at fault.
