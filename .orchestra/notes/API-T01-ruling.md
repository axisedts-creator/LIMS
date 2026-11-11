TESTS_WRONG — boot.test.ts:236-237 posts `payload: {}` to enrolAgent and expects 401; per spec the core validates the body before the security handler, so the correct answer is 400 common.validation_failed.
- Dispute's stated cause (reporting env at import) is already gone: vitest setupFiles `services/api/src/__tests__/setup-env.ts:29-31` (T0D-01) sets LIMS_CORE_ENV=ci + 32-byte LIMS_REPORTING_OTP_HMAC_KEY_FILE. Re-run 2026-11-07: 56/57 pass; "boots and mounts every instruments operation" passes. CR-C7-001 already resolved (`.orchestra/cr/API-T01.resolved-202611072147.md`); no new CR.
- Only remaining failure: "fails closed ..." — `expected 400 to be 401`, body `common.validation_failed` (field_required x4).
- spec/chunks/C0-foundation-contracts/02-TRD.md:462 — stage 3 "routing + spec validation ... → 400 common.validation_failed" precedes 02-TRD.md:463 stage 4 "security handler" (`deviceToken` resolver).
- contracts/openapi/instruments.yaml:28-32 — enrolAgent x-error-codes list common.validation_failed; :33-44 requestBody required, 4 required fields, additionalProperties false. `{}` is invalid, so 400 is the spec-mandated outcome.
- Change in the test (line 236): send a schema-valid body, e.g. the spec's synthetic example (instruments.yaml:66-69):
  `payload: { host_fingerprint_sha256: '3f2a'.repeat(16), agent_version: '1.2.0', launcher_version: '1.0.1', os_version: 'Windows 10.0.19045' }`
  and keep `expect(enrol.statusCode, enrol.body).toBe(401)` (no credential → deviceToken resolver → auth.*). Optionally also assert `JSON.parse(enrol.body).code` matches /^auth\./ like lines 231-235.
- Implementation unchanged; the GET checks (lines 231-235) and 404 check (line 238) are spec-correct and stay.
