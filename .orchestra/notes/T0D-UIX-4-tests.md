# T0D-UIX-4 tests (tester)
- `apps/web/src/core/__tests__/uix4.markup.test.ts` (+ `vitest.uix4.config.ts`): greps non-test .tsx of the 16 folders for `<table`, `<dl`, `<button` (comments stripped); fails while any remain.
- Named exceptions (ceilings, stale ones fail): AstGrid + MolecularTab `<table` (EditableGrid role=grid), admin/Grid.tsx `<table` (server-boundary cells), admin/ui.tsx 2 `<button` (picker, role=tab), admin/auth/PasswordField.tsx `<button` (pinned sign-in).
- Also pins: frontdesk PatientView + OrderView import and render DescriptionList and DataTable; OrderView has no raw table.
- Run: `.orchestra\notes\T0D-UIX-4-verify.cmd` (one pnpm line, no build step needed; node env, reads source text only).
- Not tested here: CSS values (T0D-UIX-1/5), "web tests of the touched features" (run the touched feature suites after the rewrite).
