CR_NEEDED — the spec itself is contradictory/missing
1. Plan row C6-T19 (spec/chunks/C6-reporting-delivery/06-IMPLEMENTATION-PLAN.md:31) puts "+ seed `homecollection.visit_assigned` (D-34)" in C6-T19's scope, but its Files column lists only ports/NotificationPort.impl.ts, service/delivery.service.ts, domain/messages.ts.
2. spec/program/01-CHUNK-MAP.md:107 says `db/` (incl. seeds/) is "C0-0B ONLY". :21 and :204 say a feature chunk never edits `db/`.
3. C6 05-SCHEMA.md:1455 §8 says "global seeds by migration", and 01-CHUNK-MAP.md:346 says 05-SCHEMA is "the spec C0 implements". So the seed rows belong to C0-0B.
4. The seed requirement itself is valid (08-CR-REGISTER.md:2301 D-34; 03-IC:1799 template list), so TESTS_WRONG does not fit. No C6-owned code can create a db/seeds file, so IMPLEMENTATION_WRONG does not fit either.
5. Resolution: CR-C6-022 in .orchestra/cr/C6-T19.md (route the seed to C0-0B). Until it lands, the 3 "C6-T19 seed (D-34)" cases in services/api/src/modules/reporting/__tests__/notification.static.test.ts stay red as a known blocker. Do not delete or weaken them. Writer: no implementation change is needed for these 3 cases.
