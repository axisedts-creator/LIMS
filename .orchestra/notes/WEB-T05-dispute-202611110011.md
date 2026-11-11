# WEB-T05 dispute (debugger, round 3) — 7 of 71 component tests cannot pass against any spec-conforming impl
Rerun (json reporter): 64 pass / 7 fail after impl fix. File: apps/web/src/features/instruments/__tests__/web-t05.components.test.tsx. Spec: 04-UI-UX.md:181 ("Re-match dialog"), 04-UI-UX §3 SCR-09 filters.
1. :228-237 "API failure (403/500)": override `http.post(.../messages/search, () => problem(500,...))` never calls `rec(request)`, so `searches()` is always [] and `waitFor(expect(searches()).toHaveLength(1))` can never pass. Test bug.
2. :628 and :647 (it.each 400/409/403): `rowOf()` = getByRole('row') while the Re-match dialog is open. Spec 04-UI-UX:181 says "dialog"; shared @lims/ui Dialog = react-aria Modal, which aria-hides everything outside it, so rows are inaccessible by role. Test must use `{hidden:true}` or assert after close. No spec line requires a non-modal dialog.
3. :176 `getByRole('button',{name:/^instrument/i})`: shared Select button name is "Select an item Instrument" (value text precedes label, packages/ui, not C7b-owned). `^` anchor is not required by spec; use /instrument/i.
4. :~287 `/\bH\b/` on textContent of the row: cells have no whitespace between them ("...g/dLH—Mapped"), so \b never matches. Assert on the flags cell, or use /H/.
Needed: tester fixes these 4 test issues. Impl change not possible/appropriate for any of them.
