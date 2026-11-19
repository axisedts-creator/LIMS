APPROVE
# T0D-WEBFIX-2 review (reviewer), diff f53f9c69e..HEAD

Checked:
- (1) Nav: 85 keys added to core/i18n/messages.ts; spot-checked labels (Owner dashboard, Collections history, Phlebotomy phones, Tube handovers, Partner manifests, Pathology cases, Waiting consumption, Smart summaries, TAT alerts) all appear in chunk 04-UI-UX / PRD text. Test scans every features/*/nav.manifest.ts (label/section/createLabel) + RAIL_GROUPS, fails on key==text or dotted-key text, guards against empty scan (>100 labels).
- (2) Bell: stays `disabled` (not focusable); aria-label + title + visible aria-hidden note = "Notifications arrive in a later release" (still contains "Notifications"). Test covers text, tooltip, name, focus.
- (3) B.S.: bsLabel() appends " B.S." only when missing; used in all four components that had the literal. Test renders DashboardView + ReportRunView with both input forms, plus a static guard against `} B.S.` in the four files.
- (4) PriceSimulator hint explains the field and when to leave it empty; test asserts content, not wording.
- (5) No route, permission, API, data, RLS, log or secret changes. rs-c2 baseline untouched (per LD-303).

Ran: webfix2 verify cmd = 4 files, 14/14 pass. tsc --noEmit on apps/web: no errors in touched files.

Notes (not blocking):
- 9 product files + 5 test files exceeds the brief's "at most 8 files"; writer disclosed it. The four analytics components each carried the duplicate suffix, so the cap was not reachable without leaving one broken.
- Labels without a spec nav table (admin, catalog, micro, quality, reporting, smartreport, billing.daily_cash) use page titles; lead may want to check the wording.
- Not re-run by reviewer: r04/m2 shell suites (writer reports only pre-existing motion-test reds from shell.css:128).
