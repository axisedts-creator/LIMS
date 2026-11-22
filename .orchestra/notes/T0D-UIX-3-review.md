CHANGES

Reviewed: `git diff 7636e0884..HEAD` is empty (HEAD = 7636e0884); reviewed the uncommitted working-tree diff (page.tsx + rs-c5 snapshot) and the whole task range e61b78987~1..HEAD for the lab files.

1. apps/web/src/features/lab/components/QueueScreen.tsx:296 — behaviour regression, not markup: SplitConsole j / k keyboard navigation is broken now that the queue item Button sits inside a kit DataTable grid row. `npx vitest run -c src/__tests__/vitest.uiconsole2.config.ts` fails 2/133 (run twice, deterministic): `uiconsole2.queues.test.tsx:235` "keyboard: j and k move the focus ..." for both verify and approve queues — after `j`, focus stays on REG0001 (grid focus management takes it back) instead of moving to REG0002. The impl note's "uiconsole2 (133) green" is wrong; the tester already flagged this in T0D-UIX-3-tester-open.md item 2. The test is not a markup pin (it asserts focus behaviour), so it must not change. Fix (writer): stop the grid from reclaiming focus from the console-item Button the same way line 295 does for the checkbox — wrap the Button in `<span onFocus={(e) => e.stopPropagation()}>…</span>` (and, if the grid still handles the key, also `onKeyDown` stopPropagation for `j`/`k`/`Enter` on that span), then re-run the uiconsole2 config until 133/133.

Confirmed OK:
- Working tree page.tsx:12 adds 'Instrument' to the pendingOr headers per arbiter round 3 / LD-442; display only; path (staff) is allowed by done_when (7).
- rs-c5 snapshot diff (LD-443): markup only — raw table/caption/tfoot to kit DataTable (role=grid, lims-table-regular, lims-align-*, lims-num on numeric column, react-aria ids), raw dl to lims-dl items, useId label ids. No text or data change (worklist "Select" header was visually-hidden text, same text). Regeneration accepted.
- Configs run green: rs-c5 27/27, uix3 11/11, uiconsole1 259/259, uilist1 76/76.
- No CSS, tokens, kit, platform/auth paths touched by the lab files; no routes, permissions, contracts or API changes; no PHI/secrets (synthetic fixtures only). RLS/idempotency/rate tier/error codes: not applicable (display-only task).
- Not run by reviewer: the remaining lab per-test configs (c5-t*, lab-t*, verlevel1, uiscan1, adminpage-lab-1) and tsc.
