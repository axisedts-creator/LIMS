# T0D-UIX-4 tests (tester)
- `apps/web/src/core/__tests__/uix4.markup.test.ts` (+ `vitest.uix4.config.ts`): greps non-test .tsx of the 16 folders for `<table`, `<dl`, `<button` (comments stripped); fails while any remain. Named exceptions: AstGrid + MolecularTab `<table`, admin/Grid.tsx `<table`, admin/ui.tsx 2 `<button`, admin/auth/PasswordField.tsx `<button`. No InstrumentsList exception.
- Also pins: frontdesk PatientView + OrderView import and render DescriptionList and DataTable.
- Run: `.orchestra\notes\T0D-UIX-4-verify.cmd` (unchanged, one pnpm line).
## Revision per ruling (2026-11-22)
- (A) role table->grid, cell->gridcell in inventory t24.unresolved, instruments uiguard1.instruments + web-t04.components, reporting rs-c6.screens, frontdesk regscreen2.drafts. Deviation: regscreen2.drafts "CBC" is the kit's first column = `rowheader`, not `gridcell`, so those 5 lines use `rowheader` (same name).
- Snapshots re-recorded with `-u` on the screens files only: rs-c4 (4), rs-c2 "centres drawer" (1), rs-c7 (2).
- (B) rs-c7.behaviour: 'columnheader' added to `roles` (:148); keyboard test now Tab into grid "Instruments", ArrowRight/ArrowDown/ArrowRight to the SIM-CHEM-1 row link and its mappings link, role null kept, tabindex check dropped.
- Still red, NOT ruled (left for notes/T0D-UIX-4-left.md): rs-c7.behaviour "one row per instrument" (/\bup\b/), rs-c7.static + rs-c4.static baselines, regscreen2.drafts Favourites tab.
