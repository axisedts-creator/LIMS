# API-T06 dispute (writer) — test asserts a revoke reason code that does not exist in the spec

**Test:** `services/api/src/modules/instruments/__tests__/enrolment.service.test.ts:56` (A3, AC-02.2) expects the old device token to be revoked with `revoke_reason_code: 'replaced_pc'`. Also `agents.helpers.ts:104` fake reason list; `API-T06-tests.md` line 5 lists it as an "assumption beyond spec text".

**Why wrong:** `agent_credentials.revoke_reason_code` is an FK to `instruments.g_cs_revoke_reasons`. The seed is `device_replaced`, `device_lost_or_stolen`, `suspected_compromise`, `decommissioned`, `staff_error`, `other`:
- spec/chunks/C7-instrument-integration/05-SCHEMA.md:169 and :962
- db/migrations/20261105002000_instruments__create_instruments_schema.sql:441
- contracts/openapi/instruments.yaml:1564, :1614 (`device_replaced`)

`replaced_pc` appears nowhere in spec or DB. Implementing it passes the test but fails with an FK violation (23503) on every A3 enrolment against a real database, so the service would be broken in production. Inventing a name is forbidden (CLAUDE.md).

**Requested fix (tester):** in `enrolment.service.test.ts:56` expect `'device_replaced'`; in `agents.helpers.ts:104` replace `'replaced_pc'` with `'device_replaced'` (the other fake reasons `lost_device`, `compromised`, `investigation` are also not seeded, but only matter to API-T04 tests, not this task). Update `API-T06-tests.md` line 5.

**Writer status:** stopped before writing any code. Nothing else in the tests conflicts with the spec as far as read; once the test is corrected I implement `repo/device.repo.ts`, the three services and the 5 handlers, using `device_replaced`.
