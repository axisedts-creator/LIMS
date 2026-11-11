TESTS_WRONG — the boot test omits the JWT config the core requires before it can mount bearerJwt operations; the test fixture must supply it.
Change in services/api/src/modules/billing/__tests__/unit/boot.test.ts:50: pass all four keys to loadConfig, i.e.
`loadConfig({ LIMS_CORE_ENV: 'ci', LIMS_CORE_JWT_ALG: 'HS256', LIMS_CORE_JWT_ISSUER: ISS, LIMS_CORE_JWT_AUDIENCE: AUD, LIMS_CORE_JWT_KEY_FILE: <tmp file holding a synthetic HS256 secret> })`
reusing ISS/AUD/tmpFile from services/api/src/core/auth/__tests__/helpers.ts. Keep every assertion unchanged (unauthenticated injects must still be non-2xx/non-404/405/500; 401 is expected).
Reasons:
- spec/chunks/C4-frontdesk-billing/06-IMPLEMENTATION-PLAN.md:34 — BL-T01 done-when is only "boots"; it says nothing about booting without auth config.
- spec/chunks/C0-foundation-contracts/02-TRD.md:623-624 — bearer verification is pinned to LIMS_CORE_JWT_ALG/_KEY_FILE/_ISSUER/_AUDIENCE; there is no unauthenticated/no-verifier mode, so a core with bearerJwt ops cannot boot without them (C0-owned behaviour at services/api/src/core/openapi.ts:202).
- spec/chunks/C0-foundation-contracts/02-TRD.md:945 — those keys are required env values per environment (fixed by SP-1), so supplying them in the test is the correct fixture, not a weakening.
- spec/program/02-CONVENTIONS.md:481 — bearerJwt is the API scheme, so billing ops correctly use it; billing code cannot and must not bypass this.
