# T0B-11 impl (writer, round 6, LD-51)
- `db/tools/export-tenant-billing.ts`: no change. Review round 5 had one item (`inv()` id/tenant_id swap), test-only; tester applied it at `T0B-11_billing_isolatable.sh:55`.
- Earlier rounds still hold: `SET session_replication_role = replica;` script header [CONV], PGOPTIONS `-c row_security=off`, async `fail()` flush.
- Ran `node --test tests/db/T0B-11.billing-export.test.mjs`: 19/19 pass.
- Live proof per LD-51: harness runs `.orchestra/notes/T0B-11-verify.cmd`; I did not run it (LD-51 forbids it).
- Open: if the live log shows a tool failure, writer/debugger fixes it; a seed failure goes to tester; a missing table means a CR.
