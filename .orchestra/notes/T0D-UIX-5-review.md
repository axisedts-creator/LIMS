APPROVE

Reviewed `git diff ecda4cc4c..HEAD` (T0D-UIX-5, C0-foundation-contracts).

- Scope: apps files = layout.css (new), app/layout.tsx (one import line right after shell.css), uix5.layout.test.ts, vitest.uix5.config.ts = 4 files. shell.css, kit.css, tokens.json untouched. Notes only under .orchestra/notes. Display only: no route, permission, contract, operation, API, log, secret or PHI change; no RLS surface touched.
- Values vs done_when: main padding space-4 (16px) with flex column gap space-3 (12px), no max-width set (kit/shell set none on main); PageHeader title 1rem / semibold / accent, caption xs / neutral-500, header margin-bottom space-3; .lims-grid > .lims-card height 100% (equal height); stat row equal 1fr auto columns, gap 12px, stretch; card title base / medium with caption right; states inside card/table: 24px block padding, 40px art, one-line title/body, min-height 0; stacked not-available one-row 2.5rem; block danger ErrorState / Banner one row 2.25rem, danger bg + 1px danger border, ghost-style Retry pushed right. Tokens only; !important only where shell.css already has it for the same selector+property.
- Names: every class targeted exists in packages/ui markup (Card, Banner, ErrorState, NotAvailable, StateArt, PageShell, PageHeader). Token vars used all exist in kit.css usage.
- Ran: `pnpm --dir apps/web exec vitest run --config src/core/__tests__/vitest.uix5.config.ts` -> 5 files, 100 tests passed.

Non-blocking observations (no fix required for this task):
1. Block danger ErrorState has fixed height 2.25rem but its title/body are not nowrap at block level (only inside card/table); on a very narrow main area, "Critical alerts could not be loaded" + body + Retry could wrap and overflow the row. Candidate for notes/T0D-UIX-5-left.md: add `white-space: nowrap; overflow: hidden; text-overflow: ellipsis` to `.lims-state.lims-tone-danger > p`.
2. ErrorState Retry is the default Button (kit min-height 48px); fits the 36px row only under data-density="compact" (staff default) or once T0D-UIX-1 lands 30px buttons.
3. PageHeader margin 12px + main gap 12px = 24px visible between header and next block; both are literally required by the brief (already flagged by writer and tester).
4. Stacked not-available selector keys on data-art='not-available', which today only NotAvailable (page-level) renders; Today-screen cards are out of this round per LD-442.
