# C6-T19 dispute — seed tests need a path C6 cannot write
Failing: notification.static.test.ts "C6-T19 seed (D-34)" (3 cases) read `db/seeds/*.sql` for `INSERT INTO reporting.g_message_templates`.
Spec: spec/program/01-CHUNK-MAP.md §3 line 107: `db/` (incl. seeds/) is "C0-0B ONLY". Plan row C6-T19 (06-IMPLEMENTATION-PLAN.md:31) lists only ports/NotificationPort.impl.ts, service/delivery.service.ts, domain/messages.ts.
No implementation-code change can make these pass; the only fix is a new db/seeds file owned by C0-0B.
Already raised: .orchestra/cr/C6-T19.nonblocking.md (CR-C6-022, exact SQL). Lead must route it to C0-0B (or re-scope the seed tests). 60/63 other tests pass.
