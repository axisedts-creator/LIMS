# C6-T38 impl
- Files changed: none. A2 (a)-(g) already implemented by T19/T32/T37/T41 (document.ts, assembly.service.ts, portal.service.ts, ReportingPort.impl.ts, delivery.service.ts, messages.ts, otp.ts, migration).
- Ran `.orchestra/notes/C6-T38-verify.cmd` steps manually: api 5 files / 154 tests PASS; worker 2 files / 42 tests PASS.
- pending.json: not touched (LD-70) — no stub operationIds turned real in this task.
- [CONV] No new names, no test edits, no dispute.
- Open: pgTAP `db/tests/reporting/C6-T38.a2.test.sql` NOT run (no Postgres in sandbox). Linter/typecheck not run.
