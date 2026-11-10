# AN-T20 impl (writer) — review fixes
- Review #1: report-run-page.tsx renders a `dashboard` code as a read-only Dashboard card (getDashboard with run period + scope); DashboardView gains `readOnly` (no PageHeader/AutoRefresh/Refresh/Show yesterday). ReportRunView wraps each Card in `<section aria-label>` (kit Card is a bare div) [CONV].
- Review #2: CR filed `.orchestra/cr/AN-T20.md` (ShellSession.actor.membershipId, to C2 + C0-0D); inline comment in schedules-page.tsx.
- Review #3: exports-page.tsx Period shows `addDays(business_date_to, -1)` (stored `to` exclusive).
- Extra: ScheduleEditor wires Ctrl+Enter explicitly (document keydown -> form.requestSubmit); it had relied on native implicit submit, which fails once focus leaves a text input (exposed by the new fill()).
- Tests: AN-T20 135/137; AN-T18 58/58; AN-T19 357 pass/1 skip; tsc clean in analytics (repo-wide errors are pre-existing missing nav/generated + css typings).
- Red until CR AN-T20 lands: schedules "creator as recipient" (expected per review #2) AND "hostile display name never becomes markup" — the latter only sees the name via the creator chip; tester may pick the recipient explicitly so the REQ-SEC-088 check does not hinge on the CR.
- Not run: Playwright E2E (AN-T20.analytics.spec.ts), real browser download.
