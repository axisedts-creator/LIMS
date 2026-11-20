CR_NEEDED — the brief cannot be met as written: it requires a green guard over all staff pages, but caps the task at 12 files limited to __tests__ and notes, while ~50 non-excusable files break the six rules today. CR text: .orchestra/cr/T0D-UIGUARD-1.md.
1. Brief `files` (inbox T0D-UIGUARD-1-arbiter.md:14-18): only core/__tests__, features/*/__tests__ "only to register an allowed exception", notes; "at most 12 files in all". No page or component source is in scope.
2. Brief done_when (inbox :19): the guard must fail on rules 1-6, the test "runs in the lane and on the founder PC apply script" and "Screens added later by other T0D tasks must pass it" — it must be green. Tester's run (notes/T0D-UIGUARD-1-tests.md:6) shows R1 5, R2 65, R3 21, R4 7, R5 12, R6 9 pages red, ~50-65 distinct files.
3. Brief exceptions (inbox :19): only "a page that cannot follow a rule (a pinned admin or platform page, the registration entry form, the QueueBoard display)". The brief gives no legacy-baseline class, so the arbiter cannot rule one; that needs the lead (dispute ask A/C).
4. Part that IS a test error (tester fixes it now, inside the CR or before): inbox :19 says a file a not-done T0D task owns is left alone "and list it in the notes". The REAL regex at uiguard1.guard.test.ts:73 rejects that reason. Add `owned by T0D-[A-Z0-9-]+` to REAL (exception entries must name the owning task id).
5. Also a test gap: /admin/* in app/(staff)/admin are pinned (inbox :19 "Pages and files under features/admin ... pinned by rs-c2.static") yet excused only for R1 in uiguard1.exceptions.ts; the tester adds the /admin/* entries for every rule they really break (R2 at least). Stale-entry test at :78 still holds.
6. Not wrong: rule detectors, the exceptions honesty tests (:64, :78, :86, :92), no loosening of R1-R6 assertions.
7. Precedent for cap overruns: T0D-UISETTINGS-1 CR (LD-360 pattern), resolved by lead ruling, not by the arbiter.

=== LEAD ITEM, LD-434 (2026-11-20) ===
CR-C0-0D-UIGUARD-1 decided: option A, dated legacy baseline. Every task
named in the CR as still open (T0D-PRICETOOLS-1, T0D-TESTMGMT-1,
T0D-SALES-1, T0D-PARTYSET-1, T0D-FINCTRL-1, T0D-OFFLINE-3, T0D-OFFLINE-4)
is now done, so almost every one of the roughly 50 to 65 offending files
needs the legacy baseline reason rather than the owned-by reason.

TESTER: extend the REAL regex in uiguard1.guard.test.ts to accept legacy
baseline LD-434, fix in T0D-UIGUARD-1 followed by a dash and a feature
name in caps (you choose the grouping and name), plus owned by T0D-
followed by a task id for the rare file still owned by a task that is
genuinely not done yet when you do this work. Add one exception entry
per offending route or file from your own six rule-by-rule lists,
grouped by feature area (catalog, billing, lab, smartreport, engagement,
partners, and so on). Add the matching admin section entries for every
rule the admin pages actually break today (R1 is already pinned by
rs-c2.static; your own run shows which other rules are red there). Keep
the stale-entry test exactly as it is so a legacy baseline entry stops
being accepted once its follow-up task actually fixes the file.

WRITER: within the 12-file cap, fix whichever R3 (catalog.css) and R6
(chart file) items, and any R4 page, fit in the budget alongside the
tester own edits, then write notes/T0D-UIGUARD-1-screens.md (what you
fixed, what you left) and notes/T0D-UIGUARD-1-exceptions.md (every
legacy baseline entry the tester added, by feature group and follow-up
task id) so the lead can queue the follow-up tasks straight from that
file.

Do not weaken, skip or loosen rules 1 through 6 themselves anywhere.
