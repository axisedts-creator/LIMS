# T0B-GREEN-1 impl (writer)
- Files changed: none outside this note. The tester's commit 3b085973c already holds every allowed fix (STALE/HARNESS in db/tests/**); the only remaining reds are 5 REAL defects, which are stop-list items (no policy, grant, migration or seed edit, LD-268).
- [CONV] REAL defects stay red and unedited; CRs -001..-004 in .orchestra/cr/T0B-GREEN-1.*.md carry them to the lead.
- Run 2026-11-17: `node --test tests/db/T0B-GREEN-1.pgtap.test.mjs` passed 3 of 3, 0 failed (run-suites.sh on the 12 C9..C15 suites took 134 s; no psql abort; no not ok outside the REAL list).
- Open: CR -001 smartreport CHECK NULL, -002 payments static_qr generated column, -003 lims_analytics v_pub_* views, -004 device actor vs AC-0B-3.6a (security question). No dispute filed.
