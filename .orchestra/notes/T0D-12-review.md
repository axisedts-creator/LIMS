APPROVE

Round 2 review. I checked the full diff 1712b2f..HEAD and the fixes in f0b661d..HEAD.

Checks I ran in packages/ui:
- `npx vitest run`: 12 files, 343/343 pass.
- `tsc -p tsconfig.json --noEmit`: clean.

Prior items:
1. Fixed. Tooltip, Popover, Spinner and Badge now exist, each with a story, and all four are in the axe `REQUIRED` list (stories-axe.test.tsx:16).
   - Tooltip opens on focus and closes on Esc without moving focus.
   - Popover traps Tab, Esc closes it, and focus returns to the trigger.
   - Spinner has role=status and its label comes from msg.loading.
   - Button.tsx now reuses Spinner.
   - Tests are in tooltip-popover-spinner-badge.test.tsx.
2. Fixed. Money is now `{ readonly amountPaisa; readonly currency: 'NPR' }` per 03:1103 and carries the ponytail marker. The stories and tests are updated, and no `amount_paisa` usage remains (fields.test.tsx:193 asserts it is absent).
3. Fixed in commits. The lockfile is not in the diff. `.orchestra/cr/T0D-12.md` (CR-C0-0D-001 to C0-0A) lists pins that match packages/ui/package.json exactly.

Note for orchestrator (not a defect in the diff): this worktree still has an uncommitted `M pnpm-lock.yaml` (+1202 lines). It must not be committed from lane C0-0D. Discard it (`git checkout -- pnpm-lock.yaml`) before merging.

Not verified: real-browser keyboard walk-through, Devanagari rendering, colour contrast (off in jsdom; T0D-11 covers it), lint (root eslint ignores .tsx).
