APPROVE

Re-review after fixes (writer 7c8d08339, tester b60779c3c) of diff 1d78ece4b..HEAD.
- Item 1 fixed: `useDensity` (apps/web/src/core/shell/UserMenu.tsx:16-21) mirrors data-density on <html> and removes it on unmount, so portaled Modal/Popover content follows the density and auth screens stay regular. kit.css root font rule is `:not(html)` + `body`, so 1rem stays 16 px. New shell tests cover compact on <html>, the switch to regular, and removal on unmount.
- Item 2 fixed: the .ui-run logs are gone (not tracked, not on disk).
- Re-checked: names verbatim, only owned paths, no routes/permissions/data/RLS touched, no secrets/PHI, storage try/catch + compact fallback, m-series-kit 40->30 with citation, 24 px minimum target test, 20 rows at 1366x768 (AC 7).
- Ran: packages/ui `vitest run src/components` = 31 files, 1335/1335 pass; apps/web density config (--maxWorkers=1) = 350 pass / 2 skipped (baseline skips).
- Not verified: real-browser focus ring clipping and pixel heights (jsdom only), as the impl note says.
