# T0D-OFFLINE-3 dispute (writer, LD-428 round, 2026-11-20)
rs-c4.screens "Daily cash (open shift)" snapshot still fails (rs-c4: 1 fail / 36 pass). Not OFFLINE-3 code.
Evidence: tester commit 39d877557 changes only .orchestra/notes/T0D-OFFLINE-3-tester-ld428.md (git show --stat). The note says the .snap was committed, but the last commit touching
apps/web/src/features/frontdesk/__tests__/__snapshots__/rs-c4.screens.test.tsx.snap is a96e6abff (T0D-UILIST-2). Working tree is clean, so the re-recorded snap was lost before commit again.
Diff is the same as LD-409: lims-page-status date line, role=search filter bar, no aria-describedby/hint, stat row + chart card.
Per LD-428 last paragraph: this is new information for a debug round: check that the run.ps1 merge isolation (237927bb4) actually applies to the tester step, or that the tester's git add includes the __snapshots__ path.
Writer: no implementation change. Other suites green: offline3 88, offline2 140, offline1 82, rs-c2 74.
