# T0D-UIX-2 tests (tester)
- `apps/web/src/features/catalog/__tests__/uix2.markup.test.ts` — source scan of non-test .tsx under features/catalog (comments stripped).
- `apps/web/src/features/catalog/__tests__/vitest.uix2.config.ts` — test-only config (node env, includes only uix2.*).
- Fails if any raw `<table`, `<dl` or `<button` remains; lists file (count) per tag. Also needs DataTable, DescriptionList, Button imported from `@lims/ui` somewhere in catalog.
- ALLOW (file -> tag -> reason) is empty: no exception needed (EditableGrid is kit code; no `<button>` for file input). Stale entries fail.
- Scan self-check + stale/scope checks pass today; 4 tests fail now, 3 pass: raw-tag tests (15 table files, 5 dl files, 2 button files) and the kit-import test.
- Run: `.orchestra\notes\T0D-UIX-2-verify.cmd` (or `pnpm --dir apps/web exec vitest run -c src/features/catalog/__tests__/vitest.uix2.config.ts`).
- Not covered by test: floating label/value divs (AC 4) and the screens list (notes/T0D-UIX-2-screens.md) — not greppable; reviewer checks.
