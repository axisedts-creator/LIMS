# T0B-11 impl (writer, round 10, LD-51/LD-52)
- `db/tools/export-tenant-billing.ts`: no change. Review round 9 has no implementation items; its blocker (storage migration) is ruled out of scope by LD-52.
- LD-52 skip of `*_storage__*.sql` on BOTH `$DB` and `$RDB` is already in `db/tests/billing_isolatable/T0B-11_billing_isolatable.sh` `build_db` (tester commit 9ba3b9b, comment names CR-C0-T0B-12).
- Earlier rounds still hold: `SET session_replication_role = replica;` script header [CONV], PGOPTIONS `-c row_security=off`, async `fail()` flush.
- Ran `node --test tests/db/T0B-11.billing-export.test.mjs`: 19/19 pass.
- Live proof per LD-51: harness runs `.orchestra/notes/T0B-11-verify.cmd`; not run by me. Current `.orchestra/out/T0B-11-verify.log` (19:26) predates the LD-52 skip (19:30), so it still shows the storage error.
- Open: CR-C0-T0B-12 (storage grants) stays open for T0B-12; if a non-storage migration or seed fails live, follow LD-51.
