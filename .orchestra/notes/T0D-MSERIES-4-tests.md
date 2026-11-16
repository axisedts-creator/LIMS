# T0D-MSERIES-4 tests (Find a screen oval fix, LD-266)
- Run: `.orchestra\notes\T0D-MSERIES-4-verify.cmd` (build:nav, then vitest config `core/shell/__tests__/vitest.m4.config.ts`: m4 + the existing m2/r04/t12 shell, nav, auth tests).
- New: `core/shell/__tests__/m4.source.test.ts` (6 static CSS tests), `vitest.m4.config.ts`, `tests/e2e/shell/T0D-MSERIES-4.shell.spec.ts` (Playwright, nightly: field height 40-48 px at 1280x800 and 1280x1400, compact 40 px, user card pinned; needs a stack, not in verify).
- Fail now for the right reason: `.lims-rail-search` has no `flex` (kit `.lims-input { flex: 1 }` wins), and the survey note `.orchestra/notes/T0D-MSERIES-4.md` does not exist yet (writer creates it). The other 4 m4 tests pass now and guard against over-fixing (kit.css untouched, width/min-height/radius/colours unchanged, rail layout intact).
- ASSUMPTION: `flex: 0 0 auto` is accepted as equal to `flex: none`. The survey-note test checks only that it names `lims-input`, `lims-select`, an `apps/web/...` file path and a column/flex mention.
- NOT covered: real rendered height (Playwright only), pixel look vs the founder screenshot.
