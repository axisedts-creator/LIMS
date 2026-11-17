APPROVE
- Diff 98ad3eb..HEAD: boot.test.ts:236-238 only (plus notes). Matches the ruling: the enrolAgent body is the spec's synthetic example (contracts/openapi/instruments.yaml:64-69) and passes the schema (64 lowercase hex characters, 4 required fields, no extra fields). The test still expects 401 plus an `auth.*` code.
- Ran `vitest run src/modules/instruments/__tests__/boot.test.ts`: 57/57 pass (2026-11-07). The "fails closed" case returns 401 for enrolAgent.
- No PHI or secrets in the test or the logs (the request logs carry no body). Only owned paths plus orchestra notes were touched. Nothing invented.
- Note (not a defect for T01): with no credential, enrolAgent returns core `auth.unauthenticated`, which is not in its x-error-codes (only auth.device_token_invalid). API-T03 should confirm this core default is acceptable or map it.
