# T0B-11 impl (writer, round 9, LD-51)
- `db/tools/export-tenant-billing.ts`: no change. Review round 8 had no implementation items. Its only item is a lead ruling on CR-C0-T0B-12 (storage grants in `db/bootstrap/01_database.sql`), and it says not to work around it in T0B-11 files.
- Earlier rounds still hold: `SET session_replication_role = replica;` script header [CONV], PGOPTIONS `-c row_security=off`, async `fail()` flush.
- Ran `node --test tests/db/T0B-11.billing-export.test.mjs`: 19/19 pass.
- Live proof per LD-51: the harness runs `.orchestra/notes/T0B-11-verify.cmd`. I did not run it (LD-51 forbids it).
- Open: `db/bootstrap/01_database.sql` still has no `storage` grant, so the live run stays blocked at `20261105002200_storage__create_buckets.sql` ("permission denied for schema storage") until the lead rules on CR-C0-T0B-12.
