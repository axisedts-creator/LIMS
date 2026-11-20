Title: CR-C0-0D-UIGUARD-1: guard test for the six LD-353 rules cannot go green inside the 12-file, tests-only brief
From chunk: C0-foundation-contracts (lane C0-0D)            To owner: C0-0D (lead)
Type: ui-kit
Blocking? yes — T0D-UIGUARD-1 (C0 06-IMPLEMENTATION-PLAN row T0D-UIGUARD-1)

Problem (what you cannot do today, with the user story / acceptance criterion it serves):
LD-353 / brief done_when: one web test walks the nav manifest and app/(staff) pages and fails on rules 1-6; it must run green in the lane and on the founder PC apply script, and later T0D screens must pass it.
The tester's guard (apps/web/src/core/__tests__/uiguard1.guard.test.ts) finds today: R1 5 pages, R2 65 pages, R3 21, R4 7, R5 12, R6 9 — about 50-65 distinct source files (shared components such as partners/PartysetCommon.tsx, catalog master-ui, catalog.css, ReportView, ResultPanels, SummaryReview, 7 pages without ErrorState/NotAvailable).
The brief limits the task to 12 files, only under core/__tests__, features/*/__tests__ (exception registration) and notes; no page or component may be fixed. Allowed exceptions are only pinned admin/platform pages, the registration entry form and the QueueBoard display (plus, per the brief, files owned by a not-done T0D task, "left alone and listed in the notes").
So the guard can neither be made green by fixing pages (out of scope) nor by excusing them (no legal reason class). The brief contradicts itself.

Proposed change (exact) — lead picks one:
A. Dated legacy baseline (recommended): new LD allows exception entries `{route, rule, reason: 'legacy baseline LD-<n>, fix in T0D-<follow-up id>'}`; tester adds `legacy baseline LD-<n>` and `owned by T0D-[A-Z0-9-]+` to REAL (uiguard1.guard.test.ts:73) and adds /admin/* entries for each rule they break (R2 at least, reason "pinned rs-c2.static"). Writer, within 12 files, fixes catalog.css (R3), the R6 chart files and R4 pages that fit, and writes notes/T0D-UIGUARD-1-screens.md and notes/T0D-UIGUARD-1-exceptions.md. Stale-entry test (:78) then forces each baseline entry to be removed when the follow-up fixes it.
B. Same test changes as A, but no baseline: lead splits the ~50 remaining files into follow-up T0D tasks per feature (catalog, billing, lab, smartreport, engagement, partners); UIGUARD-1 stays open until they land.
C. Lift the 12-file cap and the tests-only files list for this task (~70 files, several owned by open tasks T0D-PRICETOOLS-1, T0D-TESTMGMT-1, T0D-SALES-1, T0D-PARTYSET-1, T0D-FINCTRL-1, T0D-OFFLINE-*, which must still be excepted as "owned by").

Backward compatible? yes — test and notes only under A/B; display-only edits under C (no route, permission, contract, operation or API change).
Tenant/security impact: none (static source walk; no RLS, PHI field or public surface).
IRD/regulatory impact: none.
Alternatives considered: loosening rule detectors or skipping rules (forbidden: never weaken a test); excusing every offender as "pinned" (false reason, fails the honesty intent).
Tests that will prove it: vitest -c apps/web/src/core/__tests__/vitest.uiguard1.config.ts after pnpm run build:nav — all six rule tests and the four exceptions-honesty tests green; m2.source, r04.source, r04.shell, m4.source, elabmenu1.sidebar, m-series-kit, web-style-3 stay green.
