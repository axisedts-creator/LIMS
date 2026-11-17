# T0B-11 impl (writer, round 11, LD-51/LD-52)
- `db/tools/export-tenant-billing.ts`: no change. Review round 10 has one item, a tester fixture defect (missing CONNECT grant for `t0b11_reader`); tester fixed it in 2a92682 (`T0B-11_billing_isolatable.sh:139`).
- LD-52 skip of `*_storage__*.sql` on BOTH `$DB` and `$RDB` still in `build_db` (comment names CR-C0-T0B-12).
- Earlier rounds still hold: `SET session_replication_role = replica;` script header [CONV], PGOPTIONS `-c row_security=off`, async `fail()` flush.
- Ran `node --test tests/db/T0B-11.billing-export.test.mjs`: 19/19 pass.
- Live proof per LD-51: harness runs `.orchestra/notes/T0B-11-verify.cmd`; not run by me (docker/psql blocked).
- Open: CR-C0-T0B-12 stays open for T0B-12; if a later seed/DDL mismatch fails live, follow LD-51.
