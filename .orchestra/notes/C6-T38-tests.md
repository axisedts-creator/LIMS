# C6-T38 tests (08 Addendum A2 (a)-(g), AC-16.1)
- NEW services/api/src/modules/reporting/__tests__/t38.a2.static.test.ts — (a) CHECK/immutability, (d) bytea 32 + verifyOtp 31/33, (g) template code/seed (DDL + seed + source; no Postgres here).
- NEW services/worker/src/jobs/reporting/__tests__/assemble_smart_regeneration.test.ts — (b) Regenerate `smart_summary_added` snapshot (approved / draft / smartreport.* / flag off).
- NEW db/tests/reporting/C6-T38.a2.test.sql — live-DB twin of (a)(d)(g) (pgTAP; NOT run, no Postgres in sandbox).
- Already covered by existing suites (included in verify): (c) portal.service.test + reportingport.t37.test, (e)/(f) notification.port.test, (d) otp.test.
- Run: `.orchestra\notes\C6-T38-verify.cmd` (api: 5 files/154 tests; worker: 2 files/42 tests — all PASS at write time).
- NOTE: C6-T38's implementation already exists (T19/T32/T37/T41), so these tests are regression guards and pass now; no failing-first state exists. pending.json: not touched (LD-70).
