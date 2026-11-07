# T0B-11 impl (writer, round 8, LD-51)
- `db/tools/export-tenant-billing.ts`: no change. Review round 7 had no implementation items: item 1 is a lead ruling (CR-C0-T0B-12, storage grants in `db/bootstrap/01_database.sql`); item 2 is test-only and the tester applied it (5dc8d38: skip `*_storage__*` migrations on `$RDB`, SP-3 comment, header wording).
- Earlier rounds still hold: `SET session_replication_role = replica;` script header [CONV], PGOPTIONS `-c row_security=off`, async `fail()` flush.
- Ran `node --test tests/db/T0B-11.billing-export.test.mjs`: 19/19 pass.
- Live proof per LD-51: harness runs `.orchestra/notes/T0B-11-verify.cmd`; I did not run it (LD-51 forbids it).
- Open: live run stays blocked at `20261105002200_storage__create_buckets.sql` ("permission denied for schema storage") until the lead rules on CR-C0-T0B-12. I did not work around it in T0B-11 files.
