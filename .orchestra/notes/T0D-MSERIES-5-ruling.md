TESTS_WRONG — the one remaining red test is test-side; the implementation stands. Tester change (unchanged from the previous ruling, still not applied):
1. `apps/web/src/features/admin/__tests__/__snapshots__/rs-c2.screens.test.tsx.snap:339`: delete the whole `exports[\`visual snapshots of the key screens are recorded > snapshot: sign-in 1\`]` entry (that export only; leave users, roles-edit-privileged, centres drawer, settings untouched). Vitest already reports it obsolete.
Reasons:
- `rs-c2.screens.test.tsx:370` (tester-owned) asserts the .snap holds no `snapshot: sign-in ` entry; comment at :368 records the retirement per LD-276 (task brief LEAD DECISIONS), entry-screen structure now asserted in auth/__tests__/m5.entry.test.tsx.
- Verified at HEAD 737de42bf: the entry is still at .snap:339; the last commit touching `__snapshots__/` is 9f502f09b (RS-C2), so no tester commit applied ruling 30a284e11 item 1.
- The .snap is a test artefact; task brief done_when (5) bars the writer and debugger from editing tests, so no implementation change can turn this test green. Route to the TESTER, not back to the writer.
- No spec contradiction; no CR needed (the LD-250 route CR already filed stays).
