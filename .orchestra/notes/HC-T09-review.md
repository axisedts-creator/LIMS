APPROVE
Note: the requested range 09ae921a..HEAD is empty (HEAD = 09ae921a). Reviewed HC-T09 as it stands at HEAD (commits 91958103, fc09ceba, aa4cc581, 2c359d74).

Previous CHANGES item 1 is resolved. visit.service.ts:104 now enqueues `homecollection.refresh_visit_specimens` through `app.enqueue_job` in the assign tx, with payload `{tenant_id, visit_id}` and job_key `refresh:<visit_id>` (visitSpecimens.repo.ts:20). assign.test.ts:148-156 covers it: a successful assign leaves exactly one job, and a rolled-back assign leaves none.

Re-run of tests/homecollection/HC-T09.pg.sh on 2026-11-13: 5 files, 205/205 passed.

The earlier no-defect checks still hold: names verbatim, tenant binding, permissions, If-Match and Idempotency, route version rule, D-131 caps, SMS sent inside a savepoint, no PHI or secrets in logs, only C17 paths.
Non-blocking: enqueueRefreshVisitSpecimens duplicates specimen.service.ts:21 (same SQL). They could be consolidated later.
