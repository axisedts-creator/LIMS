APPROVE

Round 3 (re-review of 5f144d05, daebe40c, 96d0955f). Round-2 #1 FIXED: DashboardActions.tsx RefreshButton arms a setTimeout to next_allowed_at (fallback now+5 min, same end as the "available at" text) that clears `cooling` + status text; held in a ref, cleared on re-arm and unmount. Button and Alt+R share the guard.
Tests: `.orchestra/notes/AN-T18-verify.cmd` -> 3 files / 58 tests pass (15 s), incl. 4 new "refresh cooldown ends" fake-timer tests (5 min default, next_allowed_at wins, button + Alt+R post again, no timer after unmount). States file 5/5 on this run.
Rounds 1-2 items (per-tile stale badge, AutoRefresh 5 min visible-only, Alt+R registry) remain fixed. No PHI/secrets, only owned paths, whitelist-only params to API.
Residual (not blocking): `report_backlog` family for snapshot tiles is [CONV]; Playwright E2E replaced by MSW page tests; error.tsx cold-import flake is test-config side.
