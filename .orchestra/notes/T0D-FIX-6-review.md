APPROVE
# T0D-FIX-6 review (reviewer), range 76309834d..HEAD
- Diff = fixture `core/__tests__/fixtures/ctx-clock-baseline.json` set to `{}` (LD-450, tester-owned) + two notes. No source, migration, permission, route or contract-shape change. No PHI, no secret.
- Sources (afc2d7b8a, already merged): `core/clock.ts` toDate throws `common.internal` (catalog 03 §common errors, verbatim), value not echoed; pipeline ctx.now() stays a string (LD-448).
- Ran: verify.cmd set, 5 files 67/67 passed; `tsc --noEmit` clean.
- Not verified by me: registration.isoclock.test.ts (needs PG17), full module suites (writer reports 27+7 pre-existing non-clock failures). Non-blocking.
