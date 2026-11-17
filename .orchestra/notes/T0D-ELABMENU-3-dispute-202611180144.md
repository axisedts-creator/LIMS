# T0D-ELABMENU-3 dispute (writer) — TESTS_WRONG: old copy pinned by earlier tasks' suites + one stale baseline
Method: every vitest config under the touched features/core/app run with my edits, then again at HEAD (my 45 files swapped to `git show HEAD:` copies, restored after). Only failures that PASS at HEAD and FAIL with my edits are listed. Writer may not edit tests; done_when (7) says "update the tests that pin the old headings" — that is tester work.
1. Stale baseline: elabmenu3.walk (e) routes baseline has 136 entries; T0D-ACCT-2 (merged after tester commit da6baec67) added billing.cash_transfers, billing.expenses, billing.expense_types. No route/nav file touched here. Refresh elabmenu3.baseline.json.
2. Old heading / empty copy pinned (done_when 2 and 4 require the new text):
- catalog: cattests1 x3 (title "Tests", "No tests yet"), catunits1 x3 ("No units yet. Add a unit", header), emptytbl1 x2 (Units, Price lists copy), emptytbl2 x1 (heading), testfix1 x3 ("No tests yet"), web-t31 x2 ("No departments yet.", "No specimen types yet."), web-t33 x3 ("No panels yet.", "No doctors yet.", "No credit parties or affiliations yet."), web-t34 x1 ("No price list yet — create the default list first.").
- frontdesk: fd-t13 "blank" (heading /new registration/i), rs-c4 x4 (Register blank / returning / new-patient, Daily cash: screen snapshots).
- lab: adminpage-lab-1 (title "Worklists"), lab-t25 x2 (exact QC header text), rs-c5 x2 (receive, collect/dispatch snapshots).
- micro: t23 (h1 "Micro instrument data"), t24 (heading of the instrument-records screen).
- analytics: rs-c8 "Report hub (tabs)" snapshot (hub heading is now "MIS Report").
- core/shell elabmenu-wide aggregates the suites above (191 fails with edits vs 282 at HEAD).
Expected new values = t(nav label key) of the entry (table in T0D-ELABMENU-3-table.md); empty copy now names the menu label (e.g. "No test categories yet.").
Pre-existing at HEAD, not this task: vg5/vg6/vg7 tsc, nav-complete x4, m2/m4/r04 motion, rs-c3 x3, rs-c4 byte/route x4, rs-c5 server/routes x2, web-t33 createDoctor, adminpage-eng-1/fd-1/lab-1 contract bytes, t-l1, hc-t18 x2, lab-t11, lab-t26 "No worksheets.", rs-c8 "New schedule form".
