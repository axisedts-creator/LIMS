# API-T06 dispute (writer, round 2) — config fixture violates the contract; boot test stub list is stale

Implementation is written; 126/127 of the API-T06 suites pass. Remaining failures are in test files:

1. **`releases.service.test.ts:25`** (E02 schema-valid) fails on the fixture, not on the service. `device.helpers.ts:41` `configDoc()` sets
   `update.target: null` and `update.window: null`. `contracts/openapi/instruments.yaml:6755-6765` (ConfigDocument.update): `target` is
   `$ref ConfigUpdateTarget` and `window` is `type: object`, both optional and **not nullable** — absent means "none". The service returns the
   stored document unchanged (re-serialising would break the signature), so it cannot fix this. Violations reported:
   `/document/update/target must be object`, `/document/update/window must be object`.
   **Fix (tester):** in `configDoc()` omit `target` when there is no target and omit `window` (e.g. `update: { channel, allow_downgrade: false, ...(t ? { target: {...} } : {}) }`).
   The E08 service reads `document.update.target?.release_id`, so absent and null behave the same there.

2. **`boot.test.ts:39-43`** `IMPLEMENTED` still lists only the API-T04 ops, so 5 "stub X throws common.internal" cases now fail for
   enrolAgent, getAgentConfig, submitAgentHeartbeat, submitAgentLogBundle, downloadAgentRelease — the task brief requires replacing those stubs.
   **Fix (tester):** add the five operationIds to `IMPLEMENTED` (same as was done for API-T04).

Not caused by API-T06 (seen in the full instruments run): `boot.test.ts` real-repo boot times out / "module reporting: index.ts exports no manifest"
(other chunk's module), and `drivers-generic.test.ts:298` 5 s timing assertion took 7-9 s under full-suite load.
