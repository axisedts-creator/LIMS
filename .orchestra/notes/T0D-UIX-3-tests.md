# T0D-UIX-3 tests (tester)
- apps/web/src/features/lab/__tests__/uix3.markup.test.ts: greps non-test lab .tsx for raw `<table`, `<dl`, `<button` (comments skipped); exceptions map is empty (no native file input, EditableGrid internals live in packages/ui).
- Also asserts: DataTable / DescriptionList / Button imported from @lims/ui; the 14 former table files, 4 dl files and 3 button files use the kit tag; notes/T0D-UIX-3-screens.md exists; no CSS file under features/lab.
- apps/web/src/features/lab/__tests__/vitest.uix3.config.ts: test-only config (node env).
- Run: `.orchestra\notes\T0D-UIX-3-verify.cmd` (pnpm --dir apps/web exec vitest run --config src/features/lab/__tests__/vitest.uix3.config.ts).
- Expected now: raw-tag tests, kit-usage tests and screens.md test FAIL (raw tags remain, notes missing); finds-files and exceptions tests pass.
