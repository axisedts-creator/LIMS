C6-T44 impl: no source change needed. All T44 items already implemented; tests in C6-T44-tests.md pass on current tree.
- Ran: api final-sweep.test.ts 19/19 pass; worker assemble_final_sweep.test.ts 10/10 pass.
- Existing impl covers: D-61 version.ts; P-44 savepoint in assemble_report.ts; D-48 delivery_created_at in service/delivery.service.ts + v_pub_delivery_daily in migration 20261105001900; seed homecollection.visit_scheduled (db/seeds/004); P-42 commitOnError in ReportingPort.impl.ts.
- [CONV] brief lists modules/reporting/events/publish.ts; file does not exist, publishing lives in delivery.service.ts. No new file created.
- Open: probes/pending.json untouched (no stub ops converted by T44). Live-DB FORCE RLS cohort/seed cases not run (no psql here). Full suite/lint/typecheck not run.
