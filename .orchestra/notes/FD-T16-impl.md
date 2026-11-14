# FD-T16 impl (round 3)
- No code change this round: ruling round 3 = TESTS_WRONG (fixture gap); tester seeded objs() orders into lab/billing fakes (e17d4a2f).
- Round 2 code stands: order.service.ts (F8b/F13 priority default [CONV]), patient.service.ts + orders.repo.ts (F6 centre scope, 07-SECURITY §6.2), registration.service.ts (F8 tenant-bound centre, F9 unknown discount_approval_id = 404, §6.1).
- [CONV] LD-70: probes/pending.json already `[]`; no edit.
- Ran FD-T16-verify (tests/frontdesk/FD-T16.pg.sh, Docker PG17): Test Files 7 passed (7), Tests 225 passed (225).
- Not verified this round: full frontdesk suite in one run (earlier: >10 min, worker crashes on this machine).
