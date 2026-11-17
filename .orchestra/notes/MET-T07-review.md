APPROVE

MET-T07 review (reviewer, 2026-11-14), diff 5c4c1b60..HEAD
- Scope: one new test file under `services/api/src/modules/instruments/__tests__/regression/` (owned path) plus the role notes. No src, spec, contract, migration or existing test edited. Truth H80E untouched (LD-163).
- Names verbatim: `truth_h80e`, `getein_metis`, `generic`/`verified`, `instruments.driver_not_available`, `tcp_server`, version `0.1.0` and the cap flags match 09-ADDENDUM §8/§10 and the CR-C7-020 row. Nothing invented.
- Coverage vs done_when / §11: the real g_drivers rows are read, so both drivers are `generic` and none is `verified`; E22/E23/E25 show `driver_status: generic` for both; E28 go-live refused, which is the server-side gate for host query; a static guard checks for no skip/only/fails/xit and no new todo. The web toggle belongs to MET-T05 and the notes say so.
- RLS/permissions/idempotency/rate tier: none in this diff (tests only). No PHI, no secrets; the data is synthetic.
- Ran: the new file alone, 11/11 pass (2.3 s).
- Lead note (not a code defect): the full-suite verify runs in debug rounds 2 and 3 had 3 fails each: a 120_000 ms timeout in boot.test.ts and ingest.perf p95 just over 3000 ms. Both pass when run alone and come from machine load. Before closing done_when, raise the boot.test timeouts under LD-86 or rerun MET-T07-verify.cmd on an idle machine with `--pool=forks --maxWorkers=2`.
