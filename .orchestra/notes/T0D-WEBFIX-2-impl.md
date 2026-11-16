# T0D-WEBFIX-2 impl (writer)
Files: core/i18n/messages.ts (+85 nav labels, core.shell.notifications_unavailable), core/shell/ShellFrame.tsx + shell.css (bell), analytics/components/{DashboardView,ReportView,ReportRunView,ScheduleEditor}.tsx (B.S. once), catalog/components/PriceSimulator.tsx (hint).
[CONV] Nav labels copied from chunk 04-UI-UX nav tables where named (C7, C8, C11, C12, C13, C17); the rest (admin, catalog, micro, quality, reporting, smartreport, billing.daily_cash) use the screen's page name — lead may want to check wording.
Bell: stays `disabled` (out of tab order); aria-label, title and visible in-button note = "Notifications arrive in a later release" (still contains "Notifications").
B.S.: `bsLabel()` exported from DashboardView.tsx, not period.ts, because rs-c8.static pins period.ts bytes. Adds " B.S." only when label_bs lacks it.
Tests: webfix2 14/14; rs-c8 36/36; an-t18/19/20 all pass; m2 322/324 + r04 75/76: the only reds are shell motion tests, already red because of `.lims-auth-plate` 14s animation (shell.css:128, not this task).
Open: 9 product files (the brief caps the task at 8 files; shell.css is needed to lay out the bell note). rs-c8.screens snapshot is marked modified by line endings only after a vitest run (`git diff --ignore-cr-at-eol` is empty); writer did not edit it, and `git restore` was not allowed. rs-c2 baseline not touched.
