# HC-T09 dispute (writer, after review item 1)
- Impl done per review #1: `visit.service.ts` H3 calls `enqueueRefreshVisitSpecimens` (new in `repository/visitSpecimens.repo.ts`): `app.enqueue_job('homecollection.refresh_visit_specimens', {tenant_id, visit_id}, 'refresh:<visit_id>')` in the assign tx.
- Result: 22 assign.test.ts cases fail with `error: unknown_task_identifier` (P0001) from `app.enqueue_job` — every successful assign path now enqueues.
- Cause is the test DB, not the code: `app.enqueue_job` refuses identifiers missing from `core.g_task_registry` (C0 05-SCHEMA.md:1060-1063). The registry is filled only by the deploy step `services/worker/src/core/registry-sync.ts` (C0 02-TRD §7.7), which `tests/homecollection/HC-T03.pg.sh` does not run. The task itself is HC-T06's (`tasks/refresh_visit_specimens.ts`, on main, not in lane/C17).
- Precedent: tests seed the row themselves (ruling FD-T06 #1 `ensureTaskRegistry` in `frontdesk/__tests__/registration/helpers.ts:142-146`; lab `__tests__/probes/kit.ts:95-100`; `billingReal.harness.ts:63-65`). App code must never write the registry.
- Fix (test side): in `services/api/src/modules/homecollection/__tests__/dispatch/helpers.ts` (beforeAll / world setup) run as superuser, idempotent:
  `INSERT INTO core.g_task_registry (identifier,module,kind,scope,max_attempts) VALUES ('homecollection.refresh_visit_specimens','homecollection','task','per_tenant',<n>) ON CONFLICT DO NOTHING` (max_attempts = value HC-T06's worker manifest declares).
- No other implementation change expected; rerun after the fixture fix.

## Debugger confirmation (2026-11-13)
Verify log: 22 failed / 183 passed, all `unknown_task_identifier` from enqueueRefreshVisitSpecimens. Spec: 02-TRD.md:484 (refresh at assign) requires the enqueue; registry row is a test-DB fixture gap. Tester must seed `homecollection.refresh_visit_specimens` in dispatch/helpers.ts. No implementation change.
