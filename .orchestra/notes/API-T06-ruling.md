TESTS_WRONG — the test asserts revoke_reason_code 'replaced_pc', a code that does not exist in the spec; change it to 'device_replaced'.

Reasons:
- A3 (spec/chunks/C7-instrument-integration/03-APP-FLOW.md:53) and AC-02.2 (01-PRD.md:118) require: previous active token -> `revoked`, `replaced_by_credential_id` = new token, same transaction. Neither names a reason code.
- `agent_credentials.revoke_reason_code` is FK to `instruments.g_cs_revoke_reasons` (05-SCHEMA.md:54, :636). Seed = `device_replaced`, `device_lost_or_stolen`, `suspected_compromise`, `decommissioned`, `staff_error`, `other` (05-SCHEMA.md:169, :962). `replaced_pc` would violate the FK (23503) on a real DB.
- The only seeded code matching A3 semantics is `device_replaced`, also used in contracts/openapi/instruments.yaml:1564, :1614.
- CLAUDE.md forbids invented names; the tester flagged `replaced_pc` as an "assumption beyond spec text" (.orchestra/notes/API-T06-tests.md:5).

Required test changes (tester):
1. services/api/src/modules/instruments/__tests__/enrolment.service.test.ts:56 — expect `revoke_reason_code: 'device_replaced'`.
2. services/api/src/modules/instruments/__tests__/agents.helpers.ts:104 — default fake reasons = the spec seed list above (replace `lost_device`, `compromised`, `replaced_pc`, `investigation`); re-run API-T04 tests that depend on it.
3. .orchestra/notes/API-T06-tests.md:5 — replace the `replaced_pc` assumption with `device_replaced` (05-SCHEMA.md:169).
