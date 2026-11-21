# T0D-ELABMENU-3 dispute (writer, 2026-11-18 02:15 NPT)
Verify.cmd green: elabmenu3 walk/table/screens 343/343. Revised suites green: cattests1 40, catunits1 20, emptytbl1 30, emptytbl2 48, testfix1 122, web-t31 125, web-t34 116, fd-t13 70, lab-t25 37, c5-t33 203.
Test defect: the ruling (point 2) ordered snapshot regeneration for rs-c4 x4, rs-c5 x2, rs-c8 hub; tester notes say done, but commit 113080938 contains no `__snapshots__` file. Committed snapshots still pin the old headings:
- rs-c4 Register: blank / returning / new-patient: "New registration" -> received "Patient Registration"; Daily cash: "Daily cash" -> "Daily Payment Collection".
- rs-c5 receive: "Receive specimens" -> "Receive"; collect/dispatch: "Collect & dispatch" -> "Accession / Dispatch".
- rs-c8 Report hub (tabs): "Income" -> "MIS Report".
Every diff is the h1 text only (= menu label, done_when 2). Fix: tester runs `vitest -u` for those named snapshots and commits the .snap files. Implementation unchanged.
Pre-existing / out of scope (per ruling point 4): web-t33 createDoctor, rs-c4/rs-c5 static byte/route guards, rs-c8 New schedule form (data-label-placement).
Note: vitest rewrote the three .snap files with LF line endings only (no content change); writer did not stage them.
