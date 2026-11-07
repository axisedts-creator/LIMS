# T0B-11 impl (writer, round 4, LD-51)
- `db/tools/export-tenant-billing.ts`: no change this round. Review round 3 asked for no code change; its only open item is the live run.
- Earlier rounds: the script starts with `SET session_replication_role = replica;` (review #1) [CONV]. PGOPTIONS includes `-c row_security=off` (review #2). `fail()` is async and flushes before exit (debugger).
- Ran `node --test tests/db/T0B-11.billing-export.test.mjs`: 19/19 pass.
- Live proof per LD-51: the harness runs `.orchestra/notes/T0B-11-verify.cmd` (node test, then `db\tests\billing_isolatable\run-live.cmd`). The output, with the `ok - AC-0B-6.4` line, goes to `.orchestra/out/T0B-11-verify.log`. I did not run the live part myself because LD-51 forbids it.
- Open: seed-vs-DDL validity is unproven until that harness log exists. If it fails on the tool, the writer or debugger fixes it; if it fails on the seed, the tester fixes it. The export is still held in memory (ponytail comment).
