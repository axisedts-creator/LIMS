TESTS_WRONG — the dispatch test world lacks the `core.g_task_registry` row that the spec says is deploy-time data; the implementation's enqueue is required and correct.
1. Enqueue at assign is required: spec/chunks/C17-home-collection/02-TRD.md:484 (refresh "again at assign"), :514 (`homecollection.refresh_visit_specimens`, `job_key = refresh:<visit_id>`, max attempts 10); assign.test.ts:148-158 already asserts it.
2. `app.enqueue_job` raises `unknown_task_identifier` for unregistered identifiers: spec/chunks/C0-foundation-contracts/05-SCHEMA.md:1060-1063.
3. Registry is "written by `registry-sync` at deploy (02-TRD §7.7), not a static seed": C0 05-SCHEMA.md:1783. The HC-T03 boot does not run it, so the row is a test-DB fixture gap. App code must not write the registry.
4. Change in the test: `services/api/src/modules/homecollection/__tests__/dispatch/helpers.ts` gets an idempotent superuser `ensureTaskRegistry()`, called before any assign in beforeAll/world setup. Pattern: frontdesk/__tests__/registration/helpers.ts:141-148:
   `INSERT INTO core.g_task_registry (identifier,module,kind,scope,max_attempts) VALUES ('homecollection.refresh_visit_specimens','homecollection','task','per_tenant',10) ON CONFLICT DO NOTHING`
   (columns and CHECKs: C0 05-SCHEMA.md:252, :807-810; max_attempts 10 from C17 02-TRD.md:514.)
5. No change to the assertions in assign.test.ts. No implementation change.
