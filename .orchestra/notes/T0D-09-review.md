APPROVE
Round 2. Round-1 defect is fixed: replay.ts no longer calls withTenantScope. Each tenant page tx now opens with `tenantClaims(moduleSystemActor, tenantId)` the same way consumer.ts:81 does, and the header comment cites 08 R10 item 4 / A25 D-214 correctly.
Checked OK:
- Names match the spec: `core.event_log` columns per 05-SCHEMA §3201 table, `app.cron_tenant_ids()`, `app.enqueue_job` (identifier, payload, job_key, run_at, max_attempts), `evt.<m>.<type>`, job_key `<event_id>:<m>`, `core.g_system_actors`.
- SP-2: run() gets parsedCronItems.
- The 90-day guard and the EVENT_CONSUMERS check run before any DB access.
- Writes happen only through app.enqueue_job. lims_worker inherits lims_app, which has SELECT on core.event_log (05-SCHEMA §5).
- Logs carry ids and counts only. No secrets in the diff.
- The diff only touches owned paths (services/worker/src/**, .orchestra notes/cr). No existing test was modified; only bootstrap.test.ts, replay.test.ts and replay-world.ts were added.
- vitest: 112/112 pass (`pnpm exec vitest run --root services/worker src/core/__tests__`).
Non-blocking, track before deploy:
- The events/core/storage/files/audit ports are a throwing "not wired" proxy until IC X7 is wired. Any job that uses one of them goes to dead letters.
- main.ts and the replay CLI exit path have no tests.
- Real RLS and real Graphile run() are not exercised; the tests mock both.
