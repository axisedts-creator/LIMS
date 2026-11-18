# T0D-UIDASH-1 tests (tester)
Config: apps/web/src/__tests__/vitest.uidash1.config.ts; helpers: apps/web/src/__tests__/uidash1.helpers.ts.
Files (table-driven, empty + one-row per screen, LD-367): features/analytics/__tests__/uidash1.dashboard.test.tsx; features/lab/__tests__/uidash1.lab.test.tsx (board + pending);
features/billing/__tests__/uidash1.billing.test.tsx (daily cash + dues); features/quality/__tests__/uidash1.quality.test.tsx (indicators, runs, TAT, Levey-Jennings).
Updated old pin (name regex only, no assertion loosened): lab/__tests__/lab-t27.board.test.tsx (chips become StatTile buttons "Ready {count}"). Also run: analytics unslop1.dashboard.test.tsx.
Run: .orchestra\notes\T0D-UIDASH-1-verify.cmd (runs build:nav first; generated.ts is not committed).
Now: 48 failed / 46 passed (6 files); fails are the missing StatTile/ChartCard/NotAvailable/FilterBar markup, as intended.
Review round (10:06): ruling items 1-3 were already applied (switch query, tile set, LJ note). Added to uidash1.lab.test.tsx "review item 1": status filter on, tiles outside it must read "—" not 0 (currently red: Waiting '0'; writer fix = StatusBoard shownCount per review).
Not covered: rs-cN snapshots (writer regenerates, LD-362); web-style-3 and shell tests run by the writer after its CSS.
