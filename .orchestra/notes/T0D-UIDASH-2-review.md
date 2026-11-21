CHANGES
Reviewed `git diff 4584af991..de865879d`. Names, display-only scope (no route/permission/contract/API change), tokens-only CSS, no PHI/secrets, owned paths: OK. uidash2 suite 45/45 green (re-run by reviewer). Defects:

1. done_when (4) "web tests of both screens ... stay green" is NOT met. Reviewer run, same lane, after build:nav:
   - vitest.uidash1.config.ts: 7 failed / 95 (analytics/__tests__/uidash1.dashboard.test.tsx)
   - analytics/__tests__/vitest.rs-c8.config.ts: 18 failed / 36 (rs-c8.dashboard, rs-c8.screens snapshots, unslop1.dashboard)
   - frontdesk/__tests__/vitest.fd-t14.config.ts: 7 failed / 98 (fd-t14.screens, fd-t14.pages)
   - vitest.uilist2.config.ts: 2 failed / 63 (uilist2.lists worklist)
   Fix: tester re-pins these to the LD-436/LD-437 mock (header names "Accession no. … Time elapsed Status Actions", tab names with count, Resolve in the row menu, no Source column, chart titles "Billed per day"/"Tests by department", rs-c8 snapshots regenerated). Do not weaken assertions unrelated to the mock change. If any old pin is a binding spec line the mock contradicts, raise it to the arbiter instead.

2. apps/web/src/features/analytics/components/DashboardView.tsx:435-441 — the chart is titled "Billed per day" but plots `net_sales_paisa` (net of credit notes), while the "Billed" cell at :415 is `invoiced_paisa`. Two different money figures shown under one name on the same screen. Fix: either title the frame "Net sales per day" (series label already says "Net sales"), or, if the mock title must stay, draw the frame with `block('Not available yet')` like "Tests by department" (:445-447) and record the gap in the notes. Do not label net sales as billed.

3. apps/web/src/features/analytics/__tests__/uidash2.today.test.tsx — done_when (4) requires the "failed read" state for Today; the file covers empty period and no-money roles but has no failed dashboard read (API 5xx/unavailable) case. Fix (tester): add one test that the dashboard page with a failed analytics read keeps the Today header and shows the ErrorState/Retry (or the existing failed-read UI) rather than the error page, mirroring uidash2.worklist.test.tsx:240.
