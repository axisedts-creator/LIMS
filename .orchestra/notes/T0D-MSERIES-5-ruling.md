TESTS_WRONG — the one red test is a stale test artefact, not an implementation fault; the implementation stands. Change (per LEAD RULING LD-283, now applied by the WRITER, not the tester):
1. `apps/web/src/features/admin/__tests__/__snapshots__/rs-c2.screens.test.tsx.snap:339`: delete exactly the whole `exports[\`visual snapshots of the key screens are recorded > snapshot: sign-in 1\`] = \`...\`;` entry and nothing else (users, roles-edit-privileged, centres drawer, settings and every other line of every snapshot/test file untouched). Vitest already reports it obsolete.
Reasons:
- `rs-c2.screens.test.tsx:370` asserts the .snap holds no `snapshot: sign-in ` entry (retired per LD-276; entry structure now asserted in auth/__tests__/m5.entry.test.tsx). The test is right; the .snap is stale. Verified now: entry still at .snap:339.
- The dispute (19:24 NPT) predates LD-283 (20:00 NPT). Task brief done_when, LEAD RULING LD-283 paragraph, and LEAD DECISIONS LD-283: run.ps1 TestExempt makes rs-c[0-9]+ snap files writer-owned, so the WRITER MAY delete that single export; this overrides done_when (5) for this one file. "Do not dispute this test again."
- Writer's stated blocker (done_when 5) is lifted by LD-283; do not route to the tester.
- No spec contradiction; no CR needed (the LD-250 route CR CR-C0-T0D-MSERIES-5 stays as filed).
