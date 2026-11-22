# T0D-FIX-11 tests (tester)
Files: apps/web/src/__tests__/vitest.fix11.config.ts (config); features/billing/__tests__/fix11.billing.test.tsx (dues money, raw tables, inline errors dues + daily-cash);
features/lab/__tests__/fix11.statusboard.test.tsx; features/analytics/__tests__/fix11.reports.test.tsx (hub + collections); fix11.referral.test.tsx.
Run: `.orchestra\notes\T0D-FIX-11-verify.cmd` (build:nav, then vitest with the fix11 config, one file at a time). Existing billing/lab/analytics suites are not touched.
All new tests fail now for the stated reasons (screens read raw: listDues/getDailyCash/getStatusBoard errors throw or are swallowed; referral says "not enabled", 400/403 throw).

RE-PIN (ruling): an-t20.referral (text "switched off"; auth.forbidden + 5xx = inline error with reference), lab-t27.page (403 board read = LoadError, not empty board),
uidash1.billing + bl-t20.screens (getAllByText NPR 630.00 >= 1). These 4 files were added to the fix11 config include, so verify.cmd runs them; 86 pass. rs-c8: see T0D-FIX-11-left.md.

GAP FOR THE LEAD (RESOLVED by the writer's kit BarChart edit; kept for history) (done_when 1 and 2 cannot be met inside apps/web alone): the "Rs." and the "raw tables with centred headers" come from the kit BarChart
(packages/ui/src/components/BarChart/BarChart.tsx): fmt() writes `Rs. ${formatPaisa(v)}` for valueFormat="money" and its hidden data table is a plain <table>.
All five swept screens draw a BarChart. DuesList and StatusBoard already use DataTable. Needed: a ruling to edit the kit BarChart (money as "NPR 1,234.00", data table = kit table class
lims-table), or the writer keeps those tests red and records the gap in notes/T0D-FIX-11-left.md. Other kit/web tests asserting "Rs." may need the same ruling.
REVIEW ROUND 1 (review.md items 1+2, tests only): fix11.billing.test.tsx gained 9 daily-cash tests: sessions read 400/500 = one inline error + no "you need the billing.cash_report.read permission" line;
sessions 403 keeps that line (no inline error, passes now); getMyCashSession, listAccountParticulars, listAccountParties 400/500 = inline error, no error page. 8 fail now (source not fixed yet), 13 pass. Writer fixes page.tsx.
Not tested: Retry button on the new inline errors; poll (30 s) failures of the status board; tenant scoping (server side, no handler touched).
