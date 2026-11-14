# SP-2 tests
- File: db/tests/spikes/SP-2.decision.test.mjs (node:test, no deps; same layout as SP-1). Root duplicate tests/spikes/SP-2.decision.test.mjs already removed from index (LD-18).
- Run: `node --test db/tests/spikes/SP-2.decision.test.mjs`
- Checks db/meta/decisions/SP-2.md: outcome, 0.18.0 evidence, install command (lims_migrator + role lims_queue + D-201), jobs columns for queue_depth, lims_worker no DDL, lims_api only via app.enqueue_job, add_job params + unsafe_dedupe, completed jobs, permanent-failure detection, backoff formula, crontab from code, LISTEN/NOTIFY, no secrets.
- Conditional: partial needs worker DECISIONS.md + 07-SECURITY + CV §5.9 CR; fail needs founder + pg-boss.
- Expected now: all 15 fail with "db/meta/decisions/SP-2.md must exist" (verified by run).
- Live Postgres/worker behaviour not unit-testable; record evidence checked structurally only.
