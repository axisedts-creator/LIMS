TESTS_WRONG — the tests pin core operationId `requestDeviceWipe`, which the spec already gives to C17 and forbids reusing.
Reasons:
1. spec/program/02-CONVENTIONS.md:311 — operationId must be "unique across ALL specs"; :1143 makes uniqueness a spec-lint gate. The tooling enforces this too: tools/codegen/codegen.ts:465 throws "duplicate operationId across specs".
2. spec/chunks/C17-home-collection/02-TRD.md:193 (H17), plus 01-PRD.md:199 and 03-APP-FLOW.md:313, already own `requestDeviceWipe` (contracts/openapi/homecollection.yaml:1993). The C17 spec is the other chunk's to change, and CLAUDE.md forbids renaming its ids.
3. No spec file names a T0C-SYNC-1 operation; `requestDeviceWipe` comes only from the task brief (LD-322 design). Precedence puts 02-CONVENTIONS above the brief, so the name cannot be used as is.
4. `ackDeviceWipe` does not collide (it appears only in core.yaml:311), so keep it as the brief names it.
Change in the tests (nothing else):
- tools/codegen/__tests__/sync1-openapi.test.ts lines 55, 64, 249, 256, 413: rename `requestDeviceWipe` to `requestSyncDeviceWipe`. Keep method, path, permission, idempotency, status and errors as they are. This follows the brief's own pattern (registerSyncDevice, listSyncDevices, revokeSyncDevice).
- services/api/src/core/__tests__/sync1.pending.test.ts line 13 (NEW_OPS), and the expected core pending list: same rename.
- The implementation notes must record the rename and its reason (it differs from the brief), so the lead can audit it under LD-310.
