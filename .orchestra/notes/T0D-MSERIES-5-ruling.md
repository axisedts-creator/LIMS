TESTS_WRONG — the one remaining red test is test-side; the implementation stands. Tester change:
1. `apps/web/src/features/admin/__tests__/__snapshots__/rs-c2.screens.test.tsx.snap:339`: delete the whole `exports[\`visual snapshots of the key screens are recorded > snapshot: sign-in 1\`]` entry (that export only; leave users, roles-edit-privileged, centres drawer, settings untouched). Vitest already reports it obsolete.
Reasons:
- `rs-c2.screens.test.tsx:370` (tester-owned) asserts the .snap holds no `snapshot: sign-in ` entry; comment at :368 records the retirement per LD-276 (task brief LEAD DECISIONS), with entry-screen structure moved to auth/__tests__/m5.entry.test.tsx.
- Previous ruling item 3 ordered this deletion; commit a444dfca1 changed only the fixture, web-style.test.ts and rs-c2.static.test.ts, so the entry remains (verified at HEAD 45425082b, .snap:339).
- The .snap is a test artefact; task brief done_when (5) bars the writer from editing tests, so this is not an implementation fault.
- Previous ruling items 1, 2, 4 stand as applied. No spec contradiction; no CR needed (the LD-250 route CR already filed stays).
