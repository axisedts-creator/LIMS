# T0D-UIKIT-2 tests (tester)
Files (packages/ui/src/components/__tests__/): `uikit2.actionlist.test.tsx` (ActionList, whole file fails: module missing), `uikit2.kit.test.tsx` (Card title row, StatusStepper marker, state illustrations, kit.css tokens/motion, tokens.json hash pin, stories).
Run: `.orchestra\notes\T0D-UIKIT-2-verify.cmd` = `pnpm --dir packages/ui exec vitest run src/components/__tests__/uikit2.actionlist.test.tsx src/components/__tests__/uikit2.kit.test.tsx`
Now: kit file 22 failed / 10 passed (the 10 are guards: tokens.json pin, existing stepper behaviour, existing state stories); actionlist file fails on import. Contracts (prop names, class names, markup) are in each file's header comment.
DISPUTE for arbiter: done_when 2 (Card hairline + radius 12 + elevation.1) contradicts m-series-kit.test.tsx:184-200 (radius 24, "no border, no shadow") and ui-r03-kit-pass.test.tsx:133 (.lims-card -> xl). I followed done_when and did NOT edit those tests; the writer must get a ruling to update them (they cannot both pass).
Not tested: shell.css `.lims-card` !important padding/title size override in apps/web (LD-344/352 values), web feature tests, visual match to the mock (no renderer), the 7 named pins beyond the Card conflict above.
Gap: Icon has no chevron-right; writer adds it additively.
