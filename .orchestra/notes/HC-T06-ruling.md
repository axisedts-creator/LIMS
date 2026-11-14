TESTS_WRONG — two fixture bugs in services/worker/src/jobs/homecollection/__tests__/order.created.consumer.live.test.ts; no assertion about required behaviour changes.
1. Line 69 `newSpecimen`: barcode `HCT06SECRETBC<side><Date.now()><n>` is ~30 chars, but spec/chunks/C5-lab-workflow/05-SCHEMA.md:331 (= db/migrations/20261105001800_lab__create_lab_schema.sql:325) fixes `specimens__barcode__ck CHECK (barcode ~ '^[A-Z0-9]{1,20}$')`. Seeding fails before the code under test runs.
   Change to a <=20-char A-Z0-9 value that stays unique, e.g. `HCT06${w.s.toUpperCase()}${String(Date.now()).slice(-8)}${++bcN}`.
2. Line 109 `jobsFor`: selects `payload` from `graphile_worker.jobs`, but db/meta/decisions/SP-2.md:14 records that view has no payload column.
   Change to `SELECT j.key, t.identifier AS task_identifier, j.payload FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE j.key = $1`. Keep the same key `refresh:${visitId}` and the same assertions.
Do not change any other assertion. US-02-1..3 coverage (home/front_desk, home_collection source, walk_in ignored, duplicate) stays as is.
